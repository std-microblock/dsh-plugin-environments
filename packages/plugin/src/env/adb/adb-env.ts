// Android environment driven through the adb CLI.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EnvError, type DirEntry, type Stat } from '@dsh-environments/protocol'
import { Environment } from '../environment.ts'
import { decodeHostText, HostChildProcess, runHost, type RunHostOptions, type RunHostResult } from '../host-process.ts'
import {
  filterGlob,
  findScript,
  grepScript,
  parseGrep,
  parseReaddir,
  parseStat,
  readdirScript,
  shq,
  statScript,
} from '../posix-shell.ts'
import type {
  CopyOptions,
  ForwardOptions,
  GlobOptions,
  GlobOutcome,
  GrepOptions,
  GrepOutcome,
  InputActionFields,
  ReadFileOptions,
  RecursiveOptions,
  RenameOptions,
  ReverseOptions,
  Screenshot,
  SignalOptions,
  SpawnSpec,
  StatOptions,
  Tunnel,
  WriteFileOptions,
} from '../types.ts'
import { adbCommand, type AdbCommand } from './devices.ts'
import { androidKey } from './keys.ts'

export interface AdbEnvironmentOptions {
  id: string
  name?: string | undefined
  serial?: string | undefined
  adb?: AdbCommand | undefined
}

/** Device facts read when the environment opens. */
export interface AndroidInfo {
  model: string | undefined
  release: string | undefined
  abi: string | undefined
  sdk: number | undefined
}

export interface InstallApkOptions {
  replace?: boolean
  grant?: boolean
  downgrade?: boolean
}

type ShellResult = RunHostResult & { out: string }

const round = (n: number | undefined) => Math.round(n ?? NaN)

export class AdbEnvironment extends Environment {
  readonly serial: string | undefined
  readonly adb: string
  readonly adbPrefix: string[]
  android: AndroidInfo | undefined = undefined

  constructor({ id, name, serial, adb = 'adb' }: AdbEnvironmentOptions) {
    super({ id, name, kind: 'adb' })
    this.serial = serial
    const { exe, prefix } = adbCommand(adb)
    this.adb = exe
    this.adbPrefix = prefix
  }

  /** adb arguments addressing this device. */
  args(...rest: string[]): string[] {
    return [...this.adbPrefix, ...(this.serial ? ['-s', this.serial] : []), ...rest]
  }

  /** Run a script with `adb shell -T`. */
  async sh(script: string, opts: RunHostOptions = {}): Promise<ShellResult> {
    const r = await runHost(this.adb, this.args('shell', '-T', script), opts)
    return { ...r, out: decodeHostText(r.stdout) }
  }

  async open(): Promise<this> {
    const r = await runHost(this.adb, this.args('get-state'), { timeoutMs: 15000 })
    if (r.code !== 0 || !decodeHostText(r.stdout).includes('device')) {
      throw new EnvError(
        'EIO',
        `device ${this.serial ?? ''} is not available: ${r.stderr.trim() || decodeHostText(r.stdout).trim()}`,
      )
    }
    const props = await this.sh(
      'getprop ro.product.model; getprop ro.build.version.release; getprop ro.product.cpu.abi; getprop ro.build.version.sdk; id -un 2>/dev/null || echo shell',
    )
    const [model, release, abi, sdk, user] = props.out.split(/\r?\n/).map(s => s.trim())
    this.android = { model, release, abi, sdk: Number(sdk) || undefined }
    this.info = {
      os: 'android',
      family: 'posix',
      arch: abi ?? '',
      hostname: model ?? this.serial ?? '',
      user: user || 'shell',
      home: '/sdcard',
      cwd: '/data/local/tmp',
      pathSep: '/',
      shell: 'sh',
      caps: ['fs', 'glob', 'grep', 'proc', 'pty', 'tcp', 'tcp-listen', 'screenshot', 'input', 'android'],
      version: `Android ${release ?? '?'} (SDK ${sdk ?? '?'})`,
    }
    return this
  }

  override async stat(p: string, opts: StatOptions = {}): Promise<Stat | null> {
    return parseStat((await this.sh(statScript(p, opts.follow ?? true), opts)).out)
  }

  override async readdir(p: string, opts: SignalOptions = {}): Promise<DirEntry[]> {
    const r = await this.sh(readdirScript(p), opts)
    if (r.code === 3 || /No such file|Not a directory/.test(r.stderr)) throw new EnvError('ENOENT', `cannot list ${p}`)
    return parseReaddir(r.out)
  }

  override async readFile(p: string, opts: ReadFileOptions = {}): Promise<Buffer> {
    const max = opts.maxBytes ?? opts.max ?? 256 * 1024 * 1024
    let script = `cat ${shq(p)}`
    if (opts.offset !== undefined || opts.length !== undefined) {
      script = `tail -c +${(opts.offset ?? 0) + 1} ${shq(p)}${opts.length !== undefined ? ` | head -c ${opts.length}` : ''}`
    }
    const st = await this.stat(p, opts)
    if (!st) throw new EnvError('ENOENT', `no such file: ${p}`)
    if (st.type === 'dir') throw new EnvError('EISDIR', `is a directory: ${p}`)
    const want =
      opts.length !== undefined
        ? Math.min(opts.length, Math.max(0, st.size - (opts.offset ?? 0)))
        : st.size - (opts.offset ?? 0)
    if (want > max) throw new EnvError('ETOOBIG', `${p} is ${st.size} bytes (limit ${max})`)
    const r = await runHost(this.adb, this.args('exec-out', script), { signal: opts.signal, maxBytes: max + 1024 })
    return r.stdout
  }

  override async writeFile(p: string, data: Uint8Array | string, opts: WriteFileOptions = {}): Promise<Stat | null> {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
    const dir = path.posix.dirname(p)
    if (opts.mkdirs) await this.sh(`mkdir -p ${shq(dir)}`)
    if ((opts.mode ?? 'overwrite') === 'create' && (await this.stat(p)))
      throw new EnvError('EEXIST', `already exists: ${p}`)
    if (opts.mode === 'append') {
      const tmpRemote = `/data/local/tmp/.dsh-append-${process.pid}-${Date.now()}`
      await this.push(buf, tmpRemote)
      await this.sh(`cat ${shq(tmpRemote)} >> ${shq(p)}; rm -f ${shq(tmpRemote)}`)
    } else {
      await this.push(buf, p)
    }
    return this.stat(p)
  }

  /** Write bytes to a device path through a host temp file and `adb push`. */
  async push(buf: Buffer, remote: string): Promise<void> {
    const tmp = path.join(os.tmpdir(), `dsh-adb-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    fs.writeFileSync(tmp, buf)
    try {
      const r = await runHost(this.adb, this.args('push', tmp, remote))
      if (r.code !== 0) {
        throw new EnvError(
          /Permission denied|Read-only/.test(r.stderr + decodeHostText(r.stdout)) ? 'EACCES' : 'EIO',
          `adb push failed: ${(r.stderr || decodeHostText(r.stdout)).trim()}`,
        )
      }
    } finally {
      fs.rmSync(tmp, { force: true })
    }
  }

  /** Push a host file to the device. */
  async pushFile(hostPath: string, remote: string): Promise<void> {
    const r = await runHost(this.adb, this.args('push', hostPath, remote), { timeoutMs: 30 * 60 * 1000 })
    if (r.code !== 0) throw new EnvError('EIO', `adb push failed: ${(r.stderr || decodeHostText(r.stdout)).trim()}`)
  }

  /** Pull a device file to the host. */
  async pullFile(remote: string, hostPath: string): Promise<void> {
    const r = await runHost(this.adb, this.args('pull', remote, hostPath), { timeoutMs: 30 * 60 * 1000 })
    if (r.code !== 0) throw new EnvError('EIO', `adb pull failed: ${(r.stderr || decodeHostText(r.stdout)).trim()}`)
  }

  /** Run a script, map a non-zero exit to an EnvError by its message, and return the output. */
  async check(script: string, opts?: SignalOptions): Promise<string> {
    const r = await this.sh(`${script} 2>&1; echo "__rc=$?"`, opts)
    const m = /__rc=(\d+)\s*$/.exec(r.out)
    const code = m ? Number(m[1]) : r.code
    const msg = r.out.replace(/__rc=\d+\s*$/, '').trim()
    if (code !== 0) {
      const errCode = /No such file/.test(msg)
        ? 'ENOENT'
        : /File exists/.test(msg)
          ? 'EEXIST'
          : /Permission denied|Read-only/.test(msg)
            ? 'EACCES'
            : /not empty/i.test(msg)
              ? 'ENOTEMPTY'
              : 'EIO'
      throw new EnvError(errCode, msg || `command failed (${String(code)})`)
    }
    return msg
  }

  override async mkdir(p: string, opts: RecursiveOptions = {}): Promise<void> {
    await this.check(`mkdir ${opts.recursive ? '-p ' : ''}${shq(p)}`, opts)
  }

  override async remove(p: string, opts: RecursiveOptions = {}): Promise<void> {
    if (!(await this.stat(p, { follow: false }))) throw new EnvError('ENOENT', `no such file: ${p}`)
    await this.check(
      opts.recursive
        ? `rm -rf ${shq(p)}`
        : `if [ -d ${shq(p)} ] && [ ! -L ${shq(p)} ]; then rmdir ${shq(p)}; else rm -f ${shq(p)}; fi`,
      opts,
    )
  }

  override async rename(from: string, to: string, opts: RenameOptions = {}): Promise<void> {
    if (!opts.overwrite && (await this.stat(to, { follow: false })))
      throw new EnvError('EEXIST', `already exists: ${to}`)
    await this.check(`mv -f ${shq(from)} ${shq(to)}`, opts)
  }

  override async copy(from: string, to: string, opts: CopyOptions = {}): Promise<void> {
    await this.check(`cp ${(opts.recursive ?? true) ? '-r ' : ''}${shq(from)} ${shq(to)}`, opts)
  }

  override async realpath(p: string, opts: SignalOptions = {}): Promise<string> {
    return (await this.check(`realpath ${shq(p)} 2>/dev/null || readlink -f ${shq(p)}`, opts)).split('\n').pop() ?? ''
  }

  override async glob(pattern: string, opts: GlobOptions = {}): Promise<GlobOutcome> {
    const cwd = opts.cwd ?? this.info?.cwd ?? ''
    const r = await this.sh(findScript(cwd, { hidden: opts.hidden }), {
      signal: opts.signal,
      maxBytes: 64 * 1024 * 1024,
    })
    return { ...filterGlob(r.out, pattern, opts.limit ?? 1000), cwd }
  }

  override async grep(pattern: string, opts: GrepOptions = {}): Promise<GrepOutcome> {
    const cwd = opts.cwd ?? this.info?.cwd ?? ''
    const r = await this.sh(grepScript(cwd, pattern, opts), { signal: opts.signal, maxBytes: 64 * 1024 * 1024 })
    return { ...parseGrep(r.out, { filesOnly: opts.filesOnly, limit: opts.limit ?? 500, glob: opts.glob }), cwd }
  }

  override async spawn(spec: SpawnSpec): Promise<HostChildProcess> {
    let script = spec.command ?? (spec.argv ?? []).map(shq).join(' ')
    const envPrefix = Object.entries(spec.env ?? {})
      .filter(([, v]) => v !== null)
      .map(([k, v]) => `${k}=${shq(v)}`)
      .join(' ')
    if (envPrefix) script = `export ${envPrefix}; ${script}`
    if (spec.cwd) script = `cd ${shq(spec.cwd)} && ${script}`
    const child = spawn(this.adb, this.args('shell', ...(spec.pty ? ['-t', '-t'] : ['-T']), script), {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    return new HostChildProcess(child, { pty: !!spec.pty })
  }

  override async forward({
    localHost: _localHost = '127.0.0.1',
    localPort = 0,
    remoteHost = '127.0.0.1',
    remotePort,
    proto = 'tcp',
  }: ForwardOptions): Promise<Tunnel> {
    if (proto !== 'tcp') throw new EnvError('UNSUPPORTED', 'adb can only forward TCP')
    if (remoteHost !== '127.0.0.1' && remoteHost !== 'localhost') {
      throw new EnvError('UNSUPPORTED', 'adb forwards only reach the device loopback')
    }
    const r = await runHost(this.adb, this.args('forward', `tcp:${localPort}`, `tcp:${remotePort}`))
    if (r.code !== 0) throw new EnvError('EIO', `adb forward failed: ${r.stderr.trim()}`)
    const port = localPort === 0 ? Number(decodeHostText(r.stdout).trim()) : localPort
    return this.trackTunnel({
      kind: 'forward',
      proto,
      localHost: '127.0.0.1',
      localPort: port,
      remoteHost,
      remotePort,
      close: async () => {
        await runHost(this.adb, this.args('forward', '--remove', `tcp:${port}`)).catch(() => {})
      },
    })
  }

  override async reverse({
    remoteHost = '127.0.0.1',
    remotePort = 0,
    localHost = '127.0.0.1',
    localPort,
    proto = 'tcp',
  }: ReverseOptions): Promise<Tunnel> {
    if (proto !== 'tcp') throw new EnvError('UNSUPPORTED', 'adb can only reverse-forward TCP')
    const r = await runHost(this.adb, this.args('reverse', `tcp:${remotePort}`, `tcp:${localPort}`))
    if (r.code !== 0) throw new EnvError('EIO', `adb reverse failed: ${r.stderr.trim()}`)
    const port = remotePort === 0 ? Number(decodeHostText(r.stdout).trim()) : remotePort
    return this.trackTunnel({
      kind: 'reverse',
      proto,
      remoteHost,
      remotePort: port,
      localHost,
      localPort,
      close: async () => {
        await runHost(this.adb, this.args('reverse', '--remove', `tcp:${port}`)).catch(() => {})
      },
    })
  }

  override async screenshot(opts: SignalOptions = {}): Promise<Screenshot> {
    const r = await runHost(this.adb, this.args('exec-out', 'screencap', '-p'), opts)
    const png = r.stdout
    if (png.length < 24 || png.readUInt32BE(0) !== 0x89504e47)
      throw new EnvError('EIO', `screencap failed: ${r.stderr.trim()}`)
    return { png, width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
  }

  override async input(actions: readonly InputActionFields[], opts: SignalOptions = {}): Promise<void> {
    for (const a of actions) {
      switch (a.kind) {
        case 'click':
        case 'tap':
          if (a.double)
            await this.check(`input tap ${round(a.x)} ${round(a.y)}; input tap ${round(a.x)} ${round(a.y)}`, opts)
          else if (a.long)
            await this.check(`input swipe ${round(a.x)} ${round(a.y)} ${round(a.x)} ${round(a.y)} 800`, opts)
          else await this.check(`input tap ${round(a.x)} ${round(a.y)}`, opts)
          break
        case 'swipe':
          await this.check(
            `input swipe ${round(a.x)} ${round(a.y)} ${round(a.x2)} ${round(a.y2)} ${Math.round(a.durationMs ?? 300)}`,
            opts,
          )
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

  async installApk(
    hostApkPath: string,
    { replace = true, grant = true, downgrade = false }: InstallApkOptions = {},
  ): Promise<string> {
    const args = this.args(
      'install',
      ...(replace ? ['-r'] : []),
      ...(grant ? ['-g'] : []),
      ...(downgrade ? ['-d'] : []),
      hostApkPath,
    )
    const r = await runHost(this.adb, args, { timeoutMs: 15 * 60 * 1000 })
    const text = `${decodeHostText(r.stdout)}${r.stderr}`.trim()
    if (r.code !== 0 || !/Success/.test(text)) throw new EnvError('EIO', `install failed: ${text}`)
    return text
  }

  async uiDump(opts: SignalOptions = {}): Promise<string> {
    const r = await this.sh(
      'uiautomator dump /data/local/tmp/.dsh-ui.xml >/dev/null 2>&1; cat /data/local/tmp/.dsh-ui.xml; rm -f /data/local/tmp/.dsh-ui.xml',
      opts,
    )
    return r.out
  }
}
