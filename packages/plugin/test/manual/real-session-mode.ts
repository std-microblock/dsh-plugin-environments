// End-to-end check of the **separate-session** mode on a real Windows host.
//
// Needs the TermWrap install to have happened and the machine to have been rebooted
// (Environments page → install, or `dsh-env-server session install --payload packages/plugin/vendor/termwrap`),
// plus administrator approval through gsudo or UAC for the Remote Desktop logon right.
//
//   node packages/plugin/test/manual/real-session-mode.ts [account] [--keep] [--install]
//
// It probes the machine, optionally installs TermWrap (`--install`; without the flag it only
// prints what is missing, so running it never changes the system by surprise), allows the account
// to log on through RDP, opens the environment in `session` mode (generating a `.rdp` and starting
// the loopback client), then exercises screenshot/exec/input inside that session and tears
// everything down again.
import path from 'node:path'
import { errorMessage } from '@dsh-environments/protocol'
import { decodeHostText } from '../../src/env/host-process.ts'
import {
  createWindowsAccount,
  deleteWindowsAccount,
  listWindowsAccounts,
  runServerElevated,
} from '../../src/env/winuser/accounts.ts'
import { probeSession, termwrapPayload } from '../../src/env/winuser/session-mode.ts'
import { openWindowsAccount } from '../../src/env/winuser/winuser-env.ts'

const args = process.argv.slice(2)
const account = args.find(a => !a.startsWith('--')) ?? 'dshtest3'
const keep = args.includes('--keep')
const dataDir = path.resolve('.cache/session-mode')

let failures = 0
function check(label: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++
  console.log(
    `${ok ? 'PASS' : 'FAIL'} ${label}${detail === undefined ? '' : `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`,
  )
}

console.log(`== probe (account ${account}) ==`)
const status = await probeSession()
console.log(`   termsrv ${status.termsrv.version}, wrapper=${String(status.termsrv.wrapperInstalled)}`)
console.log(`   missing: ${status.missing.join(', ') || '(none)'}`)
if (!status.ready) {
  console.log('   reasons:')
  for (const r of status.reasons) console.log(`     - ${r}`)
  const payload = termwrapPayload()
  console.log(`   bundled payload: ${payload.present ? `TermWrap ${payload.version}` : 'absent'}`)
  if (!args.includes('--install')) {
    console.log('   re-run with --install to install it (needs administrator approval), then reboot')
    process.exit(1)
  }
  if (payload.present) {
    console.log('   installing (needs administrator approval)…')
    try {
      const r = await runServerElevated(['session', 'install', '--payload', payload.dir], { timeoutMs: 600000 })
      console.log(`   ${JSON.stringify(r)}`)
      console.log('   reboot, then run this script again')
    } catch (e) {
      console.log(`   install failed: ${errorMessage(e)}`)
    }
  }
  process.exit(1)
}

console.log('== account ==')
const accounts = await listWindowsAccounts()
if (!accounts.some(a => a.name.toLowerCase() === account.toLowerCase())) {
  console.log(`   creating ${account} (needs administrator approval)…`)
  await createWindowsAccount(account, { dataDir, grantPaths: [] })
}
check(
  'account exists',
  (await listWindowsAccounts()).some(a => a.name.toLowerCase() === account.toLowerCase()),
)

console.log('== open in session mode ==')
let env
try {
  env = await openWindowsAccount({ id: 'manual-session', name: account, account, dataDir, desktop: 'session' })
} catch (e) {
  check('session came up', false, errorMessage(e))
  console.log(`\n${failures} failure(s)`)
  process.exit(1)
}
check('session came up', !!env)
check('reports the session desktop', env.desktopName === `session:${account}`, env.desktopName)
console.log(`   server pid ${String(env.serverPid)} in its own session`)

try {
  const info = env.info
  check('info reports a Windows host', info?.os === 'windows', info?.os)
  const shot = await env.capture({ maxWidth: 800, cursor: true })
  check('screenshot inside the session', !!shot.png && shot.png.length > 1000, `${shot.width}x${shot.height}`)
  const who = await env.exec({ command: 'whoami' })
  const whoText = decodeHostText(who.stdout)
  check('exec as the account', whoText.includes(account.toLowerCase()), whoText.trim())
  const qwinsta = await env.exec({ command: 'query session' }).catch(() => undefined)
  if (qwinsta) console.log(`   query session:\n${decodeHostText(qwinsta.stdout).trim()}`)
  // The session has its own input desktop, so the real injection path must be used.
  const windows = await env.windows()
  console.log(`   windows visible in the session: ${windows.length}`)
} catch (e) {
  check('exercise the session', false, errorMessage(e))
} finally {
  await env.close()
  console.log('   closed the environment (the loopback client is stopped with it)')
}

if (!keep) {
  console.log('== cleanup ==')
  await deleteWindowsAccount(account, { dataDir, purgeProfile: true })
  console.log(`   deleted ${account} and its profile`)
} else {
  console.log(`   kept ${account} (--keep)`)
}

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} failure(s)`}`)
process.exit(failures === 0 ? 0 : 1)
