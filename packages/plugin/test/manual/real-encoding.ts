// Probe how Windows console output reaches the plugin (encoding of exec / pty output):
//   node packages/plugin/test/manual/real-encoding.ts [encoding]
// Prints each command's output as the model tools would see it (UTF-8 decoding).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { errorMessage } from '@dsh-environments/protocol'
import { openLocal } from '../../src/env/server/connect.ts'
import type { ExecResult, SpawnSpec } from '../../src/env/types.ts'

const encoding = process.argv[2] as SpawnSpec['encoding']
const dir = path.join(os.tmpdir(), 'dsh-编码-测试')
fs.mkdirSync(dir, { recursive: true })
fs.writeFileSync(path.join(dir, '中文.txt'), '你好\n')
// Not representable in GBK: only a UTF-8 console shows these names.
fs.writeFileSync(path.join(dir, 'emoji-😀-한국어.txt'), 'x\n')
const env = await openLocal({ id: 'enc', cwd: dir })
const enc = encoding ? { encoding } : {}
const cases: [string, SpawnSpec][] = [
  ['cmd dir nonexistent', { argv: ['cmd.exe', '/d', '/c', 'dir', 'nonexistent-文件'], ...enc }],
  ['cmd dir /b (non-GBK names)', { argv: ['cmd.exe', '/d', '/c', 'dir', '/b'], ...enc }],
  ['cmd echo 中文', { argv: ['cmd.exe', '/d', '/c', 'echo', '中文参数'], ...enc }],
  ['ping (localized)', { argv: ['ping', '-n', '1', '-w', '100', '192.0.2.1'], ...enc }],
  ['net user (localized)', { argv: ['net', 'user', 'no-such-user-x'], ...enc }],
  ['missing program', { argv: ['no-such-program-文件'], ...enc }],
  ['command: Write-Output 中文', { command: 'Write-Output "中文输出"; Get-ChildItem -Name', ...enc }],
  ['command: error', { command: 'Get-Item C:\\不存在的路径', ...enc }],
  ['command: native', { command: 'cmd /c dir nonexistent-文件; ping -n 1 -w 100 192.0.2.1', ...enc }],
  ['command: pipe to native', { command: '"中文管道😀" | findstr .', ...enc }],
  ['command: exit code', { command: 'cmd /c "exit 7"; exit $LASTEXITCODE', ...enc }],
  ['command: stdin', { command: '$input | ForEach-Object { "got:$_" }', ...enc }],
]
for (const [label, spec] of cases) {
  let r: ExecResult
  try {
    r = await env.exec(spec, label.includes('stdin') ? { stdin: '中文输入\n' } : {})
  } catch (e) {
    console.log(`--- ${label}: error ${JSON.stringify(errorMessage(e))}`)
    continue
  }
  console.log(`--- ${label} (code ${String(r.code)})`)
  console.log(`stdout: ${JSON.stringify(r.stdout.toString('utf8').trim())}`)
  console.log(`stderr: ${JSON.stringify(r.stderr.toString('utf8').trim())}`)
}
const p = await env.spawn({
  argv: [
    'powershell.exe',
    '-NoProfile',
    '-Command',
    'Write-Output "pty中文"; cmd /c dir /b; cmd /c dir nonexistent-文件; $x = Read-Host "input"; "read:$x"',
  ],
  pty: { rows: 24, cols: 120 },
})
const chunks: Buffer[] = []
p.stdout.on('data', (d: Buffer) => chunks.push(d))
await new Promise(r => setTimeout(r, 3000))
await p.write('输入😀\r')
await p.exited
await new Promise(r => setTimeout(r, 300))
console.log(
  `--- pty: ${JSON.stringify(
    Buffer.concat(chunks)
      .toString('utf8')

      .replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07/g, '')
      .trim(),
  )}`,
)
await env.close()
