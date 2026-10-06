import { openWindowsAccount } from '../lib/env/winuser-env.js'
import fs from 'node:fs'
const env = await openWindowsAccount({ id: 'w', name: 'W', account: 'dshtest1', dataDir: '.cache/wu-data', cwd: 'C:\\Users\\Public' })
console.log(env.info)
const r = await env.exec({ command: 'whoami; $env:USERPROFILE' })
console.log(r.code, r.stdout.toString())
const s = await env.screenshot().catch(e => e.message)
console.log('screenshot', s.width ?? s, s.height)
if (s.png) fs.writeFileSync('.cache/wu-shot.png', s.png)
const w = await env.writeFile('C:\\Users\\dshtest1\\probe.txt', 'x').catch(e => e.message)
console.log('write own profile', w)
const w2 = await env.writeFile('C:\\Users\\17153\\dsh-probe.txt', 'x').catch(e => e.message)
console.log('write other profile', w2)
await env.close()
