// Android environment driven through the adb CLI.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { EnvError, type DirEntry, type Stat } from '@dsh-environments/protocol'
import { decodeScreencapRaw, encodePng, isPng, pngSize } from '../../image/codec.ts'
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
  Capture,
  CaptureOptions,
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
import { actionScript, inputTextCommands, isAsciiTypable, type AndroidScreen } from './input.ts'

const ADB_IME = 'com.android.adbkeyboard/.AdbIME'

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

  /** Last known screen size in the current orientation. */
  screen: AndroidScreen | undefined = undefined
  private gzip: boolean | undefined = undefined
  private adbKeyboard: boolean | undefined = undefined

  override async screenshot(opts: SignalOptions = {}): Promise<Screenshot> {
    const cap = await this.capture(opts)
    if (cap.png) return { png: cap.png, width: cap.width, height: cap.height }
    const img = cap.image
    if (!img) throw new EnvError('EIO', 'screencap returned no image')
    return { png: encodePng(img), width: img.width, height: img.height }
  }

  /**
   * Full-screen capture. Raw `screencap` piped through `gzip -1` is about twice as fast over
   * USB as `screencap -p` (the device spends most of the time PNG-compressing).
   */
  override async capture(opts: CaptureOptions = {}): Promise<Capture> {
    if (this.gzip === undefined) {
      this.gzip = (await this.sh('command -v gzip >/dev/null 2>&1 && echo yes', opts)).out.trim() === 'yes'
    }
    if (this.gzip) {
      const r = await runHost(this.adb, this.args('exec-out', 'screencap | gzip -1'), {
        signal: opts.signal,
        maxBytes: 256 * 1024 * 1024,
      })
      try {
        const image = decodeScreencapRaw(zlib.gunzipSync(r.stdout))
        this.screen = { width: image.width, height: image.height }
        return { image, width: image.width, height: image.height, rect: { x: 0, y: 0, ...this.screen } }
      } catch {
        this.gzip = false
      }
    }
    const r = await runHost(this.adb, this.args('exec-out', 'screencap', '-p'), opts)
    const png = r.stdout
    if (!isPng(png)) throw new EnvError('EIO', `screencap failed: ${r.stderr.trim() || png.toString().slice(0, 200)}`)
    const { width, height } = pngSize(png)
    this.screen = { width, height }
    return { png, width, height, rect: { x: 0, y: 0, width, height } }
  }

  /** Screen size in the current orientation (from `wm size` and the display rotation). */
  async screenSize(opts: SignalOptions = {}): Promise<AndroidScreen> {
    if (this.screen) return this.screen
    const r = await this.sh("wm size; dumpsys input | grep -m1 -E 'SurfaceOrientation|Orientation:'", opts)
    const m = /Override size:\s*(\d+)x(\d+)/.exec(r.out) ?? /Physical size:\s*(\d+)x(\d+)/.exec(r.out)
    if (!m) throw new EnvError('EIO', `cannot read the screen size: ${r.out.trim()}`)
    let w = Number(m[1])
    let h = Number(m[2])
    if (/(SurfaceOrientation:\s*[13])|(Orientation:\s*Rotation(90|270))/.test(r.out)) [w, h] = [h, w]
    this.screen = { width: w, height: h }
    return this.screen
  }

  override async input(actions: readonly InputActionFields[], opts: SignalOptions = {}): Promise<void> {
    for (const a of actions) {
      if (a.kind === 'wait') {
        await new Promise(res => setTimeout(res, Math.min(60000, a.ms ?? 0)))
        continue
      }
      if (a.kind === 'type') {
        await this.typeText(a.text ?? '', opts)
        continue
      }
      const screen = a.kind === 'scroll' ? await this.screenSize(opts) : (this.screen ?? { width: 1080, height: 1920 })
      await this.check(actionScript(a, screen), opts)
    }
  }

  /** Whether the ADB Keyboard IME (com.android.adbkeyboard) is installed. */
  async hasAdbKeyboard(opts: SignalOptions = {}): Promise<boolean> {
    if (this.adbKeyboard === undefined) {
      this.adbKeyboard = (await this.sh('ime list -a -s 2>/dev/null', opts)).out.includes(ADB_IME)
    }
    return this.adbKeyboard
  }

  /**
   * Type text into the focused field. ASCII goes through `input text`. Other text (Chinese,
   * emoji, ...) needs the ADB Keyboard IME: it is switched on for the broadcast and the
   * previous keyboard is restored afterwards.
   */
  async typeText(text: string, opts: SignalOptions = {}): Promise<void> {
    if (isAsciiTypable(text)) {
      for (const cmd of inputTextCommands(text)) await this.check(cmd, opts)
      return
    }
    if (!(await this.hasAdbKeyboard(opts))) {
      throw new EnvError(
        'UNSUPPORTED',
        "Android's `input text` cannot type non-ASCII characters and this device has no ADB Keyboard IME. " +
          'Install ADB Keyboard (https://github.com/senzhk/ADBKeyBoard, package com.android.adbkeyboard) with install_apk ' +
          'and retry: the tool then switches to it just for typing and restores the current keyboard. ' +
          'Alternatively type ASCII only, or paste text the app already offers.',
      )
    }
    const b64 = Buffer.from(text, 'utf8').toString('base64')
    const script = [
      'prev=$(settings get secure default_input_method)',
      `ime enable ${ADB_IME} >/dev/null 2>&1`,
      `ime set ${ADB_IME} >/dev/null`,
      'sleep 0.6',
      `am broadcast -a ADB_INPUT_B64 --es msg ${b64} >/dev/null`,
      'sleep 0.3',
      `if [ -n "$prev" ] && [ "$prev" != "null" ] && [ "$prev" != "${ADB_IME}" ]; then ime set "$prev" >/dev/null; fi`,
    ].join('; ')
    await this.check(script, opts)
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

  /** uiautomator XML of the current screen (retried once: dumps fail while the UI animates). */
  async uiDump(opts: SignalOptions = {}): Promise<string> {
    const file = `/data/local/tmp/.dsh-ui-${process.pid}.xml`
    let last = ''
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await this.sh(`uiautomator dump ${file} 2>&1 >/dev/null; cat ${file} 2>/dev/null; rm -f ${file}`, opts)
      if (r.out.includes('<hierarchy'))
        return r.out.slice(r.out.indexOf('<?xml') >= 0 ? r.out.indexOf('<?xml') : r.out.indexOf('<hierarchy'))
      last = r.out.trim()
      await new Promise(res => setTimeout(res, 500))
    }
    throw new EnvError('EIO', `uiautomator dump failed: ${last.slice(0, 300) || 'no output'}`)
  }

  /** Foreground package/activity. */
  async foreground(opts: SignalOptions = {}): Promise<{ package?: string; activity?: string; raw: string }> {
    const r = await this.sh(
      "dumpsys activity activities 2>/dev/null | grep -m1 -E 'topResumedActivity|mResumedActivity'; dumpsys window 2>/dev/null | grep -m1 mCurrentFocus",
      opts,
    )
    const m = /u\d+\s+([\w.]+)\/([\w.$]+)/.exec(r.out)
    return { package: m?.[1], activity: m?.[2]?.startsWith('.') ? `${m[1]}${m[2]}` : m?.[2], raw: r.out.trim() }
  }

  /** Screen on/off and lock state. */
  async deviceState(opts: SignalOptions = {}): Promise<DeviceState> {
    const r = await this.sh(
      "dumpsys power | grep -m1 -E 'mWakefulness='; dumpsys window | grep -E '^ *(showing|secure)=|isKeyguardShowing|mDreamingLockscreen' ",
      opts,
    )
    const awake = /mWakefulness=Awake/.test(r.out)
    const locked = /isKeyguardShowing=true|^\s*showing=true|mDreamingLockscreen=true/m.test(r.out)
    const secure = /^\s*secure=true/m.test(r.out)
    return { awake, locked, secure }
  }

  /** Facts for the device tool. */
  async deviceInfo(opts: SignalOptions = {}): Promise<Record<string, string | number | boolean | undefined>> {
    this.screen = undefined
    const [screen, state, fg, extra] = await Promise.all([
      this.screenSize(opts),
      this.deviceState(opts),
      this.foreground(opts),
      this.sh(
        "wm density | tail -n1; settings get secure default_input_method; dumpsys battery | grep -m1 ' level'; dumpsys input | grep -m1 -E 'SurfaceOrientation|Orientation:'",
        opts,
      ),
    ])
    const lines = extra.out.split(/\r?\n/).map(s => s.trim())
    return {
      model: this.android?.model,
      android: `${this.android?.release ?? '?'} (SDK ${this.android?.sdk ?? '?'})`,
      abi: this.android?.abi,
      screen: `${screen.width}x${screen.height} (current orientation)`,
      density: lines[0]?.replace(/^.*:\s*/, ''),
      rotation: lines[3]?.replace(/^.*(Rotation|Orientation:?)\s*/, ''),
      foreground: fg.package ? `${fg.package}/${fg.activity ?? ''}` : fg.raw,
      keyboard: lines[1],
      adbKeyboard: (await this.hasAdbKeyboard(opts))
        ? 'installed (non-ASCII typing available)'
        : 'not installed (only ASCII typing)',
      ...describeStateFields(state),
      battery: lines[2]?.replace(/^.*:\s*/, ''),
    }
  }

  /** Wake the screen and dismiss an insecure lock screen. */
  async unlock(opts: SignalOptions = {}): Promise<string> {
    let s = await this.deviceState(opts)
    if (!s.awake) await this.check('input keyevent 224', opts)
    s = await this.deviceState(opts)
    if (!s.locked) return `${describeState(s)}; nothing to unlock`
    await this.check('wm dismiss-keyguard 2>/dev/null; sleep 0.6', opts)
    s = await this.deviceState(opts)
    if (s.locked) {
      // Swipe up from the bottom to open the bouncer / dismiss a swipe lock.
      const scr = await this.screenSize(opts)
      await this.check(
        `input swipe ${Math.round(scr.width / 2)} ${Math.round(scr.height * 0.9)} ${Math.round(scr.width / 2)} ${Math.round(scr.height * 0.3)} 300; sleep 0.6`,
        opts,
      )
      s = await this.deviceState(opts)
    }
    if (!s.locked) return `${describeState(s)}; unlocked`
    return s.secure
      ? 'The lock screen is protected by a PIN, pattern or password; it cannot be unlocked without the user. Ask the user to unlock the device.'
      : `${describeState(s)}; the lock screen is still showing`
  }
}

export interface DeviceState {
  awake: boolean
  locked: boolean
  secure: boolean
}

function describeStateFields(s: DeviceState): Record<string, string> {
  return {
    screenOn: s.awake ? 'yes' : 'no',
    locked: s.locked ? `yes${s.secure ? ' (secure: PIN/pattern/password)' : ''}` : 'no',
  }
}

export function describeState(s: DeviceState): string {
  const f = describeStateFields(s)
  return `screen on: ${f['screenOn']}, locked: ${f['locked']}`
}

export function formatForeground(fg: {
  package?: string | undefined
  activity?: string | undefined
  raw: string
}): string {
  return fg.package ? `Foreground: ${fg.package}/${fg.activity ?? '?'}` : `Foreground: ${fg.raw || 'unknown'}`
}
