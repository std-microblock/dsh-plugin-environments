// End-to-end check of the `winuser` environment on a real Windows host (needs administrator
// approval through gsudo or UAC for create/grant/delete):
//   node packages/plugin/test/manual/real-winuser-flow.ts [account] [--keep] [--no-create]
// Creates the account (default dshtest2), opens it from an inaccessible host cwd, exercises
// fs/exec/pty/screenshot/input/GUI/kill-on-disconnect, then deletes it with its profile.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { errorCode, errorMessage } from '@dsh-environments/protocol'
import { decodeHostText } from '../../src/env/host-process.ts'
import type { ServerEnvironment } from '../../src/env/server/server-env.ts'
import {
  createWindowsAccount,
  deleteWindowsAccount,
  grantWindowsAccount,
  listWindowsAccounts,
} from '../../src/env/winuser/accounts.ts'
import { openWindowsAccount } from '../../src/env/winuser/winuser-env.ts'

const args = process.argv.slice(2)
const account = args.find(a => !a.startsWith('--')) ?? 'dshtest2'
const keep = args.includes('--keep')
const create = !args.includes('--no-create')
const dataDir = path.resolve('.cache/wu-flow')
const work = path.resolve('.cache/wu-flow-工作区')
fs.mkdirSync(work, { recursive: true })

if (args.includes('--crash-child')) {
  // Open the environment, report the server pid and die without closing anything.
  const env = await openWindowsAccount({ id: 'c', account, dataDir })
  console.log(`SERVER_PID=${String(env.serverPid)}`)
  process.exit(3)
}

let failures = 0
function check(label: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++
  console.log(
    `${ok ? 'PASS' : 'FAIL'} ${label}${detail === undefined ? '' : `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`,
  )
}
function host(cmd: string, argv: string[], cwd?: string): string {
  const r = spawnSync(cmd, argv, { windowsHide: true, cwd })
  return decodeHostText(Buffer.concat([r.stdout, r.stderr]))
}
const alive = (pid: number | undefined) =>
  pid !== undefined && host('tasklist', ['/fo', 'csv', '/nh', '/fi', `PID eq ${pid}`]).includes(`"${pid}"`)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const text = (b: Buffer) => b.toString('utf8').trim()

if (create && !(await listWindowsAccounts()).some(a => a['name'] === account)) {
  const t = Date.now()
  await createWindowsAccount(account, { dataDir })
  check('create account', true, `${Date.now() - t} ms`)
}
await grantWindowsAccount(account, work).then(
  () => check('grant workspace', true),
  (e: unknown) => check('grant workspace', false, errorMessage(e)),
)

// The harness usually runs from a directory the account cannot enter.
const origin = process.cwd()
process.chdir(os.homedir())
let env: ServerEnvironment | undefined
const t0 = Date.now()
try {
  env = await openWindowsAccount({ id: 'w', name: 'W', account, dataDir })
  check('open (first logon creates the profile)', true, `${Date.now() - t0} ms`)
} catch (e) {
  check('open', false, `${errorCode(e) ?? ''} ${errorMessage(e)}`)
}

if (env) {
  const info = env.info
  check('server runs as the account', info?.user.toLowerCase() === account.toLowerCase(), info?.user)
  const profile = info?.home ?? ''
  check('home is the account profile', /\\Users\\/i.test(profile) && profile.toLowerCase().includes(account), profile)
  check('default cwd is the profile', info?.cwd.toLowerCase() === profile.toLowerCase(), info?.cwd)

  const vars = await env.exec({
    command:
      '"$env:USERNAME|$env:USERPROFILE|$env:APPDATA|$env:LOCALAPPDATA|$env:TEMP|$([Environment]::GetFolderPath(\'Desktop\'))"',
  })
  const parts = text(vars.stdout).split('|')
  check(
    'environment belongs to the account',
    parts[0]?.toLowerCase() === account && parts.slice(1).every(p => p.toLowerCase().startsWith(profile.toLowerCase())),
    parts,
  )
  const who = await env.exec({ argv: ['whoami', '/groups'] })
  const groups = text(who.stdout)
  check('medium integrity, not elevated', /S-1-16-8192/.test(groups) && !/S-1-16-12288/.test(groups))

  const own = path.win32.join(profile, 'dsh-探针.txt')
  check(
    'write own profile',
    await env.writeFile(own, '你好').then(
      () => true,
      () => false,
    ),
  )
  const other = path.join(os.homedir(), `dsh-probe-${account}.txt`)
  const denied = await env.writeFile(other, 'x').then(
    () => 'written',
    (e: unknown) => errorCode(e) ?? errorMessage(e),
  )
  check("cannot write the harness user's profile", denied === 'EACCES', denied)
  fs.rmSync(other, { force: true })
  check(
    'write granted workspace (non-ASCII path)',
    await env.writeFile(path.join(work, '文件.txt'), '内容').then(
      () => true,
      () => false,
    ),
  )
  const inWork = await env.exec({ command: 'Get-Content 文件.txt -Encoding UTF8', cwd: work })
  check('exec in granted workspace', text(inWork.stdout) === '内容', text(inWork.stdout) || text(inWork.stderr))

  const err = await env.exec({ command: 'Get-Item C:\\不存在的路径' })
  const errText = text(err.stderr)
  check(
    'error text is readable',
    errText.includes('不存在的路径') && !errText.includes('\ufffd'),
    errText.split('\n')[0],
  )

  const pty = await env.spawn({ argv: ['cmd.exe', '/d', '/c', 'echo pty-中文 & whoami'], pty: { rows: 24, cols: 100 } })
  let ptyOut = ''
  pty.stdout.on('data', (d: Buffer) => (ptyOut += d.toString('utf8')))
  await pty.exited
  await sleep(300)
  check(
    'pty',
    ptyOut.includes('pty-中文') && ptyOut.toLowerCase().includes(account),
    ptyOut.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').trim(),
  )

  const gui = await env.spawn({ argv: ['notepad.exe'] })
  await sleep(2500)
  const win = await env.exec({
    command: '(Get-Process notepad -ErrorAction SilentlyContinue | Where-Object MainWindowHandle -ne 0).Count',
  })
  check('GUI app opens a window on the desktop', Number(text(win.stdout)) > 0, text(win.stdout))

  try {
    const shot = await env.screenshot()
    check('screenshot', shot.width > 0 && shot.png.length > 1000, `${shot.width}x${shot.height}`)
    fs.writeFileSync(path.resolve(path.dirname(dataDir), 'wu-flow-shot.png'), shot.png)
  } catch (e) {
    check('screenshot', false, errorMessage(e))
  }
  await gui.kill()
  try {
    await env.input([{ kind: 'move', x: 37, y: 41 }])
    // Physical pixels, like sys.input and sys.screenshot.
    const pos = await env.exec({
      command:
        'Add-Type -Name D -Namespace W -MemberDefinition \'[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();\'; [void][W.D]::SetProcessDPIAware(); Add-Type -AssemblyName System.Windows.Forms; $p=[System.Windows.Forms.Cursor]::Position; "$($p.X),$($p.Y)"',
    })
    check('input moves the shared cursor', text(pos.stdout) === '37,41', text(pos.stdout) || text(pos.stderr))
  } catch (e) {
    check('input', false, errorMessage(e))
  }

  // Processes die with the connection.
  const long = await env.spawn({ argv: ['ping', '-n', '300', '127.0.0.1'] })
  await sleep(800)
  const kids = await env.exec({
    command: `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${String(long.pid)}").ProcessId`,
  })
  const pingPid = Number(text(kids.stdout).split(/\s+/)[0]) || undefined
  check('long-running child started', alive(pingPid), pingPid)
  const serverPid = env.serverPid
  await env.close()
  await sleep(3000)
  check('server exits after disconnect', !alive(serverPid), serverPid)
  check('children are killed on disconnect', !alive(pingPid) && !alive(long.pid), [long.pid, pingPid])

  // ... and when the harness dies without closing.
  const crash = host(process.execPath, [path.resolve(origin, process.argv[1] ?? ''), account, '--crash-child'], origin)
  const crashedPid = Number(/SERVER_PID=(\d+)/.exec(crash)?.[1]) || undefined
  await sleep(3000)
  check('server dies with the harness', crashedPid !== undefined && !alive(crashedPid), crashedPid ?? crash)
}

if (!keep) {
  try {
    await deleteWindowsAccount(account, { dataDir })
    check('delete', true)
  } catch (e) {
    check('delete', false, errorMessage(e))
  }
  const left = (await listWindowsAccounts()).some(a => a['name'] === account)
  check('account gone', !left)
  const profiles = host('reg', [
    'query',
    'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList',
    '/s',
    '/v',
    'ProfileImagePath',
  ])
  check('profile unregistered', !profiles.toLowerCase().includes(`\\users\\${account}`))
  const dirs = fs.readdirSync('C:\\Users').filter(d => d.toLowerCase().startsWith(account))
  check('profile directory removed', dirs.length === 0, dirs)
}
console.log(failures ? `${failures} check(s) failed` : 'all checks passed')
process.exitCode = failures ? 1 : 0
