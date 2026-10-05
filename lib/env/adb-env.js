// Android environment driven through the adb CLI.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Environment } from './environment.js'
import { EnvError } from '../protocol/client.js'
import { filterGlob, findScript, grepScript, parseGrep, parseReaddir, parseStat, readdirScript, shq, statScript } from './posix-shell.js'

/** Run a host command and collect its output. */
export function runHost(cmd, args, { input, signal, timeoutMs = 120000, maxBytes = 64 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    const out = []
    const err = []
    let size = 0
    child.stdout.on('data', d => { size += d.length; if (size <= maxBytes) out.push(d) })
    child.stderr.on('data', d => err.push(d))
    const kill = () => { try { child.kill() } catch {} }
    const timer = setTimeout(kill, timeoutMs)
    signal?.addEventListener('abort', kill, { once: true })
    child.on('error', e => { clearTimeout(timer); reject(new EnvError(e.code === 'ENOENT' ? 'ENOENT' : 'EIO', `${cmd}: ${e.message}`)) })
    child.on('close', code => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', kill)
      if (size > maxBytes) return reject(new EnvError('ETOOBIG', `output exceeds ${maxBytes} bytes`))
      resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString() })
    })
    child.stdin.on('error', () => {})
    if (input !== undefined) child.stdin.end(input)
    else child.stdin.end()
  })
}

/** Wrap a host child process in the environment process interface. */
export class HostChildProcess {
  constructor(child, { pty = false, onResize } = {}) {
    this.child = child
    this.pid = child.pid
    this.pty = pty
    this.stdin = child.stdin
    this.stdout = child.stdout
    this.stderr = child.stderr
    this.onResize = onResize
    child.stdin.on('error', () => {})
    this.exited = new Promise(resolve => {
      child.once('error', () => resolve({ code: null, signal: 'ERROR' }))
      child.once('close', (code, signal) => resolve({ code, signal }))
    })
  }

  write(data) {
    return new Promise((resolve, reject) => this.child.stdin.write(data, e => (e ? reject(e) : resolve())))
  }

  end() {
    this.child.stdin.end()
  }

  async resize(rows, cols) {
    await this.onResize?.(rows, cols)
  }

  async kill() {
    if (this.child.exitCode !== null) return
    if (process.platform === 'win32') {
      await runHost('taskkill', ['/T', '/F', '/PID', String(this.child.pid)]).catch(() => {})
    } else {
      try { this.child.kill('SIGKILL') } catch {}
    }
  }
}

/** adb may be a path or [executable, ...leading args]. */
function adbCommand(adb) {
  const [exe, ...prefix] = Array.isArray(adb) ? adb : [adb]
  return { exe, prefix }
}

/** List devices known to adb. */
export async function listAdbDevices(adb = 'adb') {
  const { exe, prefix } = adbCommand(adb)
  const { stdout } = await runHost(exe, [...prefix, 'devices', '-l'], { timeoutMs: 15000 })
  const devices = []
  for (const line of stdout.toString().split(/\r?\n/).slice(1)) {
    const m = /^(\S+)\s+(\S+)(.*)$/.exec(line.trim())
    if (!m) continue
    const props = Object.fromEntries([...m[3].matchAll(/(\w+):(\S+)/g)].map(x => [x[1], x[2]]))
    devices.push({ serial: m[1], state: m[2], model: props.model, product: props.product, device: props.device, transportId: props.transport_id, emulator: m[1].startsWith('emulator-') })
  }
  return devices
}

export class AdbEnvironment extends Environment {
  constructor({ id, name, serial, adb = 'adb' }) {
    super({ id, name, kind: 'adb' })
    this.serial = serial
    const { exe, prefix } = adbCommand(adb)
    this.adb = exe
    this.adbPrefix = prefix
  }

  args(...rest) {
    return [...this.adbPrefix, ...this.serial ? ['-s', this.serial] : [], ...rest]
  }

  async sh(script, opts = {}) {
    const r = await runHost(this.adb, this.args('shell', script), opts)
    return { ...r, out: r.stdout.toString() }
  }

  async open() {
    const r = await runHost(this.adb, this.args('get-state'), { timeoutMs: 15000 })
    if (r.code !== 0 || !r.stdout.toString().includes('device')) {
      throw new EnvError('EIO', `device ${this.serial ?? ''} is not available: ${r.stderr.trim() || r.stdout.toString().trim()}`)
    }
    const props = await this.sh('getprop ro.product.model; getprop ro.build.version.release; getprop ro.product.cpu.abi; getprop ro.build.version.sdk; id -un 2>/dev/null || echo shell')
    const [model, release, abi, sdk, user] = props.out.split(/\r?\n/).map(s => s.trim())
    this.android = { model, release, abi, sdk: Number(sdk) || undefined }
    this.info = {
      os: 'android', family: 'posix', arch: abi ?? '', hostname: model ?? this.serial ?? '', user: user || 'shell',
      home: '/sdcard', cwd: '/data/local/tmp', pathSep: '/', shell: 'sh',
      caps: ['fs', 'glob', 'grep', 'proc', 'pty', 'tcp', 'tcp-listen', 'screenshot', 'input', 'android'],
      version: `Android ${release ?? '?'} (SDK ${sdk ?? '?'})`,
    }
    return this
  }

  async stat(p, opts = {}) {
    return parseStat((await this.sh(statScript(p, opts.follow ?? true), opts)).out)
  }

  async readdir(p, opts = {}) {
    const r = await this.sh(readdirScript(p), opts)
    if (r.code === 3 || /No such file|Not a directory/.test(r.stderr)) throw new EnvError('ENOENT', `cannot list ${p}`)
    return parseReaddir(r.out)
  }

  async readFile(p, opts = {}) {
    const max = opts.maxBytes ?? opts.max ?? 256 * 1024 * 1024
    let script = `cat ${shq(p)}`
    if (opts.offset !== undefined || opts.length !== undefined) {
      script = `tail -c +${(opts.offset ?? 0) + 1} ${shq(p)}${opts.length !== undefined ? ` | head -c ${opts.length}` : ''}`
    }
    const st = await this.stat(p, opts)
    if (!st) throw new EnvError('ENOENT', `no such file: ${p}`)
    if (st.type === 'dir') throw new EnvError('EISDIR', `is a directory: ${p}`)
    const want = opts.length !== undefined ? Math.min(opts.length, Math.max(0, st.size - (opts.offset ?? 0))) : st.size - (opts.offset ?? 0)
    if (want > max) throw new EnvError('ETOOBIG', `${p} is ${st.size} bytes (limit ${max})`)
    const r = await runHost(this.adb, this.args('exec-out', script), { ...opts, maxBytes: max + 1024 })
    return r.stdout
  }

  async writeFile(p, data, opts = {}) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
    const dir = path.posix.dirname(p)
    if (opts.mkdirs) await this.sh(`mkdir -p ${shq(dir)}`)
    if ((opts.mode ?? 'overwrite') === 'create' && await this.stat(p)) throw new EnvError('EEXIST', `already exists: ${p}`)
    if (opts.mode === 'append') {
      const tmpRemote = `/data/local/tmp/.dsh-append-${process.pid}-${Date.now()}`
      await this.push(buf, tmpRemote)
      await this.sh(`cat ${shq(tmpRemote)} >> ${shq(p)}; rm -f ${shq(tmpRemote)}`)
    } else {
      await this.push(buf, p)
    }
    return this.stat(p)
  }

  async push(buf, remote) {
    const tmp = path.join(os.tmpdir(), `dsh-adb-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    fs.writeFileSync(tmp, buf)
    try {
      const r = await runHost(this.adb, this.args('push', tmp, remote))
      if (r.code !== 0) throw new EnvError(/Permission denied|Read-only/.test(r.stderr + r.stdout) ? 'EACCES' : 'EIO', `adb push failed: ${(r.stderr || r.stdout.toString()).trim()}`)
    } finally {
      fs.rmSync(tmp, { force: true })
    }
  }

  /** Push a host file to the device. */
  async pushFile(hostPath, remote) {
    const r = await runHost(this.adb, this.args('push', hostPath, remote), { timeoutMs: 30 * 60 * 1000 })
    if (r.code !== 0) throw new EnvError('EIO', `adb push failed: ${(r.stderr || r.stdout.toString()).trim()}`)
  }

  /** Pull a device file to the host. */
  async pullFile(remote, hostPath) {
    const r = await runHost(this.adb, this.args('pull', remote, hostPath), { timeoutMs: 30 * 60 * 1000 })
    if (r.code !== 0) throw new EnvError('EIO', `adb pull failed: ${(r.stderr || r.stdout.toString()).trim()}`)
  }

  async check(script, opts) {
    const r = await this.sh(`${script} 2>&1; echo "__rc=$?"`, opts)
    const m = /__rc=(\d+)\s*$/.exec(r.out)
    const code = m ? Number(m[1]) : r.code
    const msg = r.out.replace(/__rc=\d+\s*$/, '').trim()
    if (code !== 0) {
      const errCode = /No such file/.test(msg) ? 'ENOENT' : /File exists/.test(msg) ? 'EEXIST' : /Permission denied|Read-only/.test(msg) ? 'EACCES' : /not empty/i.test(msg) ? 'ENOTEMPTY' : 'EIO'
      throw new EnvError(errCode, msg || `command failed (${code})`)
    }
    return msg
  }

  async mkdir(p, opts = {}) {
    await this.check(`mkdir ${opts.recursive ? '-p ' : ''}${shq(p)}`, opts)
  }

  async remove(p, opts = {}) {
    if (!(await this.stat(p, { follow: false }))) throw new EnvError('ENOENT', `no such file: ${p}`)
    await this.check(opts.recursive ? `rm -rf ${shq(p)}` : `if [ -d ${shq(p)} ] && [ ! -L ${shq(p)} ]; then rmdir ${shq(p)}; else rm -f ${shq(p)}; fi`, opts)
  }

  async rename(from, to, opts = {}) {
    if (!opts.overwrite && await this.stat(to, { follow: false })) throw new EnvError('EEXIST', `already exists: ${to}`)
    await this.check(`mv -f ${shq(from)} ${shq(to)}`, opts)
  }

  async copy(from, to, opts = {}) {
    await this.check(`cp ${opts.recursive ?? true ? '-r ' : ''}${shq(from)} ${shq(to)}`, opts)
  }

  async realpath(p, opts = {}) {
    return (await this.check(`realpath ${shq(p)} 2>/dev/null || readlink -f ${shq(p)}`, opts)).split('\n').pop()
  }

  async glob(pattern, opts = {}) {
    const cwd = opts.cwd ?? this.info.cwd
    const r = await this.sh(findScript(cwd, { hidden: opts.hidden }), { ...opts, maxBytes: 64 * 1024 * 1024 })
    return { ...filterGlob(r.out, pattern, opts.limit ?? 1000), cwd }
  }

  async grep(pattern, opts = {}) {
    const cwd = opts.cwd ?? this.info.cwd
    const r = await this.sh(grepScript(cwd, pattern, opts), { signal: opts.signal, maxBytes: 64 * 1024 * 1024 })
    return { ...parseGrep(r.out, { filesOnly: opts.filesOnly, limit: opts.limit ?? 500, glob: opts.glob }), cwd }
  }

  async spawn(spec) {
    let script = spec.command ?? spec.argv.map(shq).join(' ')
    const envPrefix = Object.entries(spec.env ?? {}).filter(([, v]) => v !== null).map(([k, v]) => `${k}=${shq(v)}`).join(' ')
    if (envPrefix) script = `export ${envPrefix}; ${script}`
    if (spec.cwd) script = `cd ${shq(spec.cwd)} && ${script}`
    const child = spawn(this.adb, this.args('shell', ...spec.pty ? ['-t', '-t'] : ['-T'], script), { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    return new HostChildProcess(child, { pty: !!spec.pty })
  }

  async forward({ localHost = '127.0.0.1', localPort = 0, remoteHost = '127.0.0.1', remotePort, proto = 'tcp' }) {
    if (proto !== 'tcp') throw new EnvError('UNSUPPORTED', 'adb can only forward TCP')
    if (remoteHost !== '127.0.0.1' && remoteHost !== 'localhost') throw new EnvError('UNSUPPORTED', 'adb forwards only reach the device loopback')
    const r = await runHost(this.adb, this.args('forward', `tcp:${localPort}`, `tcp:${remotePort}`))
    if (r.code !== 0) throw new EnvError('EIO', `adb forward failed: ${r.stderr.trim()}`)
    const port = localPort === 0 ? Number(r.stdout.toString().trim()) : localPort
    return this.trackTunnel({
      kind: 'forward', proto, localHost: '127.0.0.1', localPort: port, remoteHost, remotePort,
      close: async () => { await runHost(this.adb, this.args('forward', '--remove', `tcp:${port}`)).catch(() => {}) },
    })
  }

  async reverse({ remoteHost = '127.0.0.1', remotePort = 0, localHost = '127.0.0.1', localPort, proto = 'tcp' }) {
    if (proto !== 'tcp') throw new EnvError('UNSUPPORTED', 'adb can only reverse-forward TCP')
    const r = await runHost(this.adb, this.args('reverse', `tcp:${remotePort}`, `tcp:${localPort}`))
    if (r.code !== 0) throw new EnvError('EIO', `adb reverse failed: ${r.stderr.trim()}`)
    const port = remotePort === 0 ? Number(r.stdout.toString().trim()) : remotePort
    return this.trackTunnel({
      kind: 'reverse', proto, remoteHost, remotePort: port, localHost, localPort,
      close: async () => { await runHost(this.adb, this.args('reverse', '--remove', `tcp:${port}`)).catch(() => {}) },
    })
  }

  async screenshot(opts = {}) {
    const r = await runHost(this.adb, this.args('exec-out', 'screencap', '-p'), opts)
    const png = r.stdout
    if (png.length < 24 || png.readUInt32BE(0) !== 0x89504e47) throw new EnvError('EIO', `screencap failed: ${r.stderr.trim()}`)
    return { png, width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
  }

  async input(actions, opts = {}) {
    for (const a of actions) {
      switch (a.kind) {
        case 'click':
        case 'tap':
          if (a.double) await this.check(`input tap ${Math.round(a.x)} ${Math.round(a.y)}; input tap ${Math.round(a.x)} ${Math.round(a.y)}`, opts)
          else if (a.long) await this.check(`input swipe ${Math.round(a.x)} ${Math.round(a.y)} ${Math.round(a.x)} ${Math.round(a.y)} 800`, opts)
          else await this.check(`input tap ${Math.round(a.x)} ${Math.round(a.y)}`, opts)
          break
        case 'swipe':
          await this.check(`input swipe ${Math.round(a.x)} ${Math.round(a.y)} ${Math.round(a.x2)} ${Math.round(a.y2)} ${Math.round(a.durationMs ?? 300)}`, opts)
          break
        case 'scroll': {
          const x = Math.round(a.x ?? 540)
          const y = Math.round(a.y ?? 1200)
          const dy = Math.round((a.dy ?? 0) * 300)
          const dx = Math.round((a.dx ?? 0) * 300)
          await this.check(`input swipe ${x} ${y} ${x - dx} ${y - dy} 300`, opts)
          break
        }
        case 'type':
          await this.check(`input text ${shq(String(a.text).replace(/ /g, '%s'))}`, opts)
          break
        case 'key':
          await this.check(`input keyevent ${androidKey(a.key)}`, opts)
          break
        case 'wait':
          await new Promise(r => setTimeout(r, Math.min(60000, a.ms ?? 0)))
          break
        default:
          throw new EnvError('EINVAL', `unsupported input action ${a.kind}`)
      }
    }
  }

  // ---- Android specifics ---------------------------------------------------

  async installApk(hostApkPath, { replace = true, grant = true, downgrade = false } = {}) {
    const args = this.args('install', ...replace ? ['-r'] : [], ...grant ? ['-g'] : [], ...downgrade ? ['-d'] : [], hostApkPath)
    const r = await runHost(this.adb, args, { timeoutMs: 15 * 60 * 1000 })
    const text = `${r.stdout.toString()}${r.stderr}`.trim()
    if (r.code !== 0 || !/Success/.test(text)) throw new EnvError('EIO', `install failed: ${text}`)
    return text
  }

  async uiDump(opts = {}) {
    const r = await this.sh('uiautomator dump /data/local/tmp/.dsh-ui.xml >/dev/null 2>&1; cat /data/local/tmp/.dsh-ui.xml; rm -f /data/local/tmp/.dsh-ui.xml', opts)
    return r.out
  }

  async closeTransport() {}
}

const KEYS = {
  home: 3, back: 4, call: 5, endcall: 6, up: 19, down: 20, left: 21, right: 22, center: 23, 'volume_up': 24, 'volume_down': 25,
  power: 26, camera: 27, clear: 28, tab: 61, space: 62, enter: 66, del: 67, backspace: 67, delete: 112, menu: 82, search: 84,
  'app_switch': 187, recent: 187, escape: 111, esc: 111, 'page_up': 92, 'page_down': 93, 'move_home': 122, 'move_end': 123, wakeup: 224, sleep: 223,
}

function androidKey(key) {
  const k = String(key).toLowerCase().replace(/^keycode_/, '')
  if (/^\d+$/.test(k)) return k
  if (KEYS[k] !== undefined) return KEYS[k]
  return `KEYCODE_${k.toUpperCase()}`
}
