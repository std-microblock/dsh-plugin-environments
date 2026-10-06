// Open an existing dsh-managed Windows account and probe it:
//   node packages/plugin/test/manual/real-winuser.ts
import fs from 'node:fs'
import { errorMessage } from '@dsh-environments/protocol'
import { openWindowsAccount } from '../../src/env/winuser/winuser-env.ts'

const env = await openWindowsAccount({
  id: 'w',
  name: 'W',
  account: 'dshtest1',
  dataDir: '.cache/wu-data',
  cwd: 'C:\\Users\\Public',
})
console.log(env.info)
const r = await env.exec({ command: 'whoami; $env:USERPROFILE' })
console.log(r.code, r.stdout.toString())
try {
  const s = await env.screenshot()
  console.log('screenshot', s.width, s.height)
  fs.mkdirSync('.cache', { recursive: true })
  fs.writeFileSync('.cache/wu-shot.png', s.png)
} catch (e) {
  console.log('screenshot', errorMessage(e))
}
const w = await env.writeFile('C:\\Users\\dshtest1\\probe.txt', 'x').catch(errorMessage)
console.log('write own profile', w)
const w2 = await env.writeFile('C:\\Users\\17153\\dsh-probe.txt', 'x').catch(errorMessage)
console.log('write other profile', w2)
await env.close()
