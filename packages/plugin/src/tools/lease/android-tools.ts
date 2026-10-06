// Android-only tools of a borrowed adb environment.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AdbEnvironment } from '../../env/adb/adb-env.ts'
import { TEXT_OUTPUT, baseName, clip } from '../common.ts'
import type { LeaseToolContext } from './context.ts'

/** Compact one-line-per-node description of a uiautomator dump. */
export function compactUiXml(xml: string): string {
  const nodes: string[] = []
  const re = /<node\b([^>]*)\/?>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml))) {
    const attrs: Record<string, string | undefined> = {}
    for (const [, key, value] of (m[1] ?? '').matchAll(/([\w-]+)="([^"]*)"/g)) if (key) attrs[key] = value
    const label = attrs['text'] || attrs['content-desc']
    const id = attrs['resource-id']
    const clickable = attrs['clickable'] === 'true'
    if (!label && !id && !clickable) continue
    const cls = (attrs['class'] ?? '').split('.').pop()
    const b = attrs['bounds']?.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/)
    const center = b
      ? ` @(${Math.round((+(b[1] ?? 0) + +(b[3] ?? 0)) / 2)},${Math.round((+(b[2] ?? 0) + +(b[4] ?? 0)) / 2)})`
      : ''
    nodes.push(
      `${cls}${id ? ` #${id.split('/').pop()}` : ''}${label ? ` "${label}"` : ''}${clickable ? ' [clickable]' : ''}${attrs['checked'] === 'true' ? ' [checked]' : ''}${attrs['enabled'] === 'false' ? ' [disabled]' : ''}${center}`,
    )
  }
  return nodes.join('\n')
}

export function addAndroidTools(t: LeaseToolContext, env: AdbEnvironment): void {
  const { label: name, add, workspaceOf } = t

  add({
    name: 'install_apk',
    description: `Install an APK on ${name}. apk_path is read from this session's workspace unless "source" names another borrowed environment alias.`,
    parameters: {
      apk_path: { type: 'string', required: true, description: 'Path of the .apk file.' },
      source: {
        type: 'string',
        description: "Alias of another borrowed environment that holds the file (default: this session's workspace).",
      },
      replace: { type: 'boolean', description: 'Replace an installed app (default true).' },
      downgrade: { type: 'boolean', description: 'Allow version downgrade.' },
    },
    output: TEXT_OUTPUT,
    timeoutMs: 20 * 60 * 1000,
    async execute(args, exec) {
      const { env: srcEnv, cwd: srcCwd, hostPath } = await workspaceOf(exec, args.source, args.apk_path)
      let local = hostPath
      let temp: string | undefined
      if (!local) {
        const p = srcEnv.resolvePath(args.apk_path, srcCwd)
        const data = await srcEnv.readFile(p, { maxBytes: 4 * 1024 * 1024 * 1024, signal: exec.signal })
        temp = path.join(os.tmpdir(), `dsh-apk-${Date.now()}-${baseName(p)}`)
        fs.writeFileSync(temp, data)
        local = temp
      }
      try {
        const text = await env.installApk(local, { replace: args.replace ?? true, downgrade: !!args.downgrade })
        return `Installed ${baseName(args.apk_path)} on ${name}: ${text.split('\n').pop()}`
      } finally {
        if (temp) fs.rmSync(temp, { force: true })
      }
    },
  })

  add({
    name: 'app',
    description: `Manage Android apps on ${name}: launch, stop, clear data, uninstall, show info, or list installed packages.`,
    parameters: {
      action: {
        type: 'string',
        enum: ['launch', 'stop', 'clear', 'uninstall', 'info', 'list', 'current'],
        required: true,
        description: 'Operation.',
      },
      package: { type: 'string', description: 'Package name, e.g. com.example.app (filter text for list).' },
      activity: { type: 'string', description: 'Activity to launch (default: the launcher activity).' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const pkg = args.package
      const need = () => {
        if (!pkg) throw new Error('package is required')
      }
      const run = async (cmd: string) => {
        const r = await env.exec({ command: cmd }, { signal: exec.signal, timeoutMs: 60000 })
        return `${r.stdout.toString()}${r.stderr.toString()}`.trim()
      }
      switch (args.action) {
        case 'launch':
          need()
          return args.activity
            ? await run(`am start -W -n ${pkg}/${args.activity}`)
            : await run(`monkey -p ${pkg} -c android.intent.category.LAUNCHER 1 2>&1 | tail -n 2`)
        case 'stop':
          need()
          await run(`am force-stop ${pkg}`)
          return `stopped ${pkg}`
        case 'clear':
          need()
          return await run(`pm clear ${pkg}`)
        case 'uninstall':
          need()
          return await run(`pm uninstall ${pkg}`)
        case 'info':
          need()
          return clip(
            await run(
              `dumpsys package ${pkg} | grep -E 'versionName|versionCode|firstInstallTime|lastUpdateTime|targetSdk|enabled=' | head -n 20`,
            ),
          )
        case 'current':
          return await run(`dumpsys window | grep -E 'mCurrentFocus|mFocusedApp' | head -n 2`)
        case 'list':
        default:
          return (
            clip(await run(`pm list packages -3${pkg ? ` | grep -i ${JSON.stringify(pkg)}` : ''}`)) ||
            'No third-party packages'
          )
      }
    },
  })

  add({
    name: 'ui_dump',
    description: `Describe the current Android UI of ${name}: visible elements with text, resource ids, flags and tap coordinates. Prefer this over screenshots for locating controls.`,
    parameters: { raw: { type: 'boolean', description: 'Return the raw uiautomator XML.' } },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const xml = await env.uiDump({ signal: exec.signal })
      if (!xml.includes('<hierarchy')) throw new Error(`uiautomator dump failed: ${xml.slice(0, 300)}`)
      return clip(args.raw ? xml : compactUiXml(xml) || '(no labelled elements)')
    },
  })

  add({
    name: 'logcat',
    description: `Read recent Android log lines from ${name}.`,
    parameters: {
      lines: { type: 'integer', description: 'Number of recent lines (default 200).' },
      filter: { type: 'string', description: 'Only keep lines containing this text (case-insensitive).' },
      level: { type: 'string', enum: ['V', 'D', 'I', 'W', 'E', 'F'], description: 'Minimum priority (default V).' },
      clear: { type: 'boolean', description: 'Clear the log buffer after reading.' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const n = Math.min(5000, args.lines ?? 200)
      const r = await env.exec(
        { command: `logcat -d -v time -t ${args.filter ? 20000 : n} *:${args.level ?? 'V'}` },
        { signal: exec.signal, timeoutMs: 60000 },
      )
      let lines = r.stdout.toString().split(/\r?\n/)
      const filter = args.filter
      if (filter) lines = lines.filter(l => l.toLowerCase().includes(filter.toLowerCase())).slice(-n)
      if (args.clear) await env.exec({ command: 'logcat -c' }, { signal: exec.signal })
      return clip(lines.join('\n')) || '(empty)'
    },
  })
}
