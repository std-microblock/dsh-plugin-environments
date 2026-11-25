// Android-only tools of borrowed adb environments.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AdbEnvironment, describeState, formatForeground } from '../../env/adb/adb-env.ts'
import { shq } from '../../env/adb/input.ts'
import type { Environment } from '../../env/environment.ts'
import { TEXT_OUTPUT, baseName, clip } from '../common.ts'
import { ENV_PARAM, GUI_ENV_PARAM, type EnvToolContext, type LeaseTarget } from './context.ts'

const isAdb = (env: Environment) => env instanceof AdbEnvironment

function adbOf(t: LeaseTarget): AdbEnvironment {
  if (!(t.env instanceof AdbEnvironment)) throw new Error(`${t.alias} is not an Android device`)
  return t.env
}

export function addAndroidTools({ add, use, workspaceOf }: EnvToolContext): void {
  const apkTarget = use({ name: 'install_apk', gui: false, supports: isAdb })

  add({
    name: 'install_apk',
    description:
      'Android devices only. Install an APK on a borrowed device. apk_path is read from this session\'s workspace unless "source" names another borrowed environment alias.',
    parameters: {
      ...ENV_PARAM,
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
      const t = await apkTarget(exec, args.environment)
      const env = adbOf(t)
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
        return `Installed ${baseName(args.apk_path)} on ${t.label}: ${text.split('\n').pop()}`
      } finally {
        if (temp) fs.rmSync(temp, { force: true })
      }
    },
  })

  const appTarget = use({ name: 'app', gui: false, supports: isAdb })
  add({
    name: 'app',
    description:
      'Android devices only. Manage apps on a borrowed device: launch (by package), stop, clear data, uninstall, info, list installed packages, current (foreground app/activity), open_url (open a link or deep link with the default handler), start (am start with an explicit intent).',
    parameters: {
      ...ENV_PARAM,
      action: {
        type: 'string',
        enum: ['launch', 'stop', 'clear', 'uninstall', 'info', 'list', 'current', 'open_url', 'start'],
        required: true,
        description: 'Operation.',
      },
      package: { type: 'string', description: 'Package name, e.g. com.example.app (filter text for list).' },
      activity: {
        type: 'string',
        description: 'launch/start: activity class (".MainActivity" or full name) or a full component "pkg/.Activity".',
      },
      url: {
        type: 'string',
        description: 'open_url: http(s) URL or deep link (also used as the intent data for start).',
      },
      intent_action: { type: 'string', description: 'start: intent action, e.g. android.settings.WIFI_SETTINGS.' },
      extras: {
        type: 'object',
        additionalProperties: true,
        description: 'start: string extras {"key": "value"}.',
      },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const env = adbOf(await appTarget(exec, args.environment))
      const pkg = args.package
      const need = () => {
        if (!pkg) throw new Error('package is required')
      }
      const run = async (cmd: string) => {
        const r = await env.exec({ command: cmd }, { signal: exec.signal, timeoutMs: 60000 })
        return `${r.stdout.toString()}${r.stderr.toString()}`.trim()
      }
      const component = () => {
        const act = args.activity
        if (!act) return undefined
        if (act.includes('/')) return act
        if (!pkg) throw new Error('package is required with a bare activity name')
        return `${pkg}/${act}`
      }
      switch (args.action) {
        case 'launch':
          need()
          return args.activity
            ? await run(`am start -W -n ${shq(component() ?? '')}`)
            : await run(`monkey -p ${shq(pkg ?? '')} -c android.intent.category.LAUNCHER 1 2>&1 | tail -n 2`)
        case 'stop':
          need()
          await run(`am force-stop ${shq(pkg ?? '')}`)
          return `stopped ${pkg}`
        case 'clear':
          need()
          return await run(`pm clear ${shq(pkg ?? '')}`)
        case 'uninstall':
          need()
          return await run(`pm uninstall ${shq(pkg ?? '')}`)
        case 'info':
          need()
          return clip(
            await run(
              `dumpsys package ${shq(pkg ?? '')} | grep -E 'versionName|versionCode|firstInstallTime|lastUpdateTime|targetSdk|enabled=' | head -n 20`,
            ),
          )
        case 'current':
          return formatForeground(await env.foreground({ signal: exec.signal }))
        case 'open_url': {
          if (!args.url) throw new Error('url is required')
          const out = await run(
            `am start -W -a android.intent.action.VIEW -d ${shq(args.url)}${pkg ? ` -p ${shq(pkg)}` : ''}`,
          )
          return `${clip(out)}\n${formatForeground(await env.foreground({ signal: exec.signal }))}`
        }
        case 'start': {
          const parts = ['am start -W']
          if (args.intent_action) parts.push(`-a ${shq(args.intent_action)}`)
          if (args.url) parts.push(`-d ${shq(args.url)}`)
          const comp = component()
          if (comp) parts.push(`-n ${shq(comp)}`)
          else if (pkg) parts.push(`-p ${shq(pkg)}`)
          for (const [k, v] of Object.entries(args.extras ?? {}))
            parts.push(`--es ${shq(k)} ${shq(typeof v === 'string' ? v : JSON.stringify(v))}`)
          if (parts.length === 1) throw new Error('start needs intent_action, url, activity or package')
          const out = await run(parts.join(' '))
          return `${clip(out)}\n${formatForeground(await env.foreground({ signal: exec.signal }))}`
        }
        case 'list':
        default:
          return (
            clip(await run(`pm list packages -3${pkg ? ` | grep -i ${shq(pkg)}` : ''}`)) || 'No third-party packages'
          )
      }
    },
  })

  const logTarget = use({ name: 'logcat', gui: false, supports: isAdb })
  add({
    name: 'logcat',
    description: 'Android devices only. Read recent log lines from a borrowed device.',
    parameters: {
      ...ENV_PARAM,
      lines: { type: 'integer', description: 'Number of recent lines (default 200).' },
      filter: { type: 'string', description: 'Only keep lines containing this text (case-insensitive).' },
      level: { type: 'string', enum: ['V', 'D', 'I', 'W', 'E', 'F'], description: 'Minimum priority (default V).' },
      clear: { type: 'boolean', description: 'Clear the log buffer after reading.' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const env = adbOf(await logTarget(exec, args.environment))
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

/** Android tools that drive the device screen (GUI leases only). */
export function addAndroidGuiTools({ add, use }: EnvToolContext): void {
  const target = use({ name: 'device', gui: true, supports: isAdb })
  add({
    name: 'device',
    description:
      'Android devices only (needs the GUI). Device state and controls: info (model, Android version, screen size/density/rotation, foreground app, keyboard, screen on/locked, battery), wake, sleep, unlock (wake and dismiss a lock screen that has no PIN/pattern/password; reports when a secure lock needs the user), notifications / quick_settings (open the shade), collapse (close it). Navigation keys (back, home, recents) are env_input key actions.',
    parameters: {
      ...GUI_ENV_PARAM,
      action: {
        type: 'string',
        enum: ['info', 'wake', 'sleep', 'unlock', 'notifications', 'quick_settings', 'collapse'],
        description: 'Default info.',
      },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const env = adbOf(await target(exec, args.environment))
      const signal = exec.signal
      switch (args.action ?? 'info') {
        case 'wake':
          await env.check('input keyevent 224', { signal })
          return describeState(await env.deviceState({ signal }))
        case 'sleep':
          await env.check('input keyevent 223', { signal })
          return 'screen off'
        case 'unlock':
          return await env.unlock({ signal })
        case 'notifications':
          await env.check('cmd statusbar expand-notifications', { signal })
          return 'notification shade opened'
        case 'quick_settings':
          await env.check('cmd statusbar expand-settings', { signal })
          return 'quick settings opened'
        case 'collapse':
          await env.check('cmd statusbar collapse', { signal })
          return 'panels collapsed'
        default: {
          const info = await env.deviceInfo({ signal })
          return Object.entries(info)
            .filter(([, v]) => v !== undefined && v !== '')
            .map(([k, v]) => `${k}: ${String(v)}`)
            .join('\n')
        }
      }
    },
  })
}
