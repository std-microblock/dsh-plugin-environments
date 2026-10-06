#!/usr/bin/env node
// A fake `adb` for tests: runs "device" commands through the local POSIX sh.
import { spawn } from 'node:child_process'
import fs from 'node:fs'

let args = process.argv.slice(2)
if (args[0] === '-s') args = args.slice(2)
const [cmd, ...rest] = args

const sh = (script, stdio = 'inherit') => {
  const child = spawn('sh', ['-c', script], { stdio })
  child.on('close', code => process.exit(code ?? 1))
  return child
}

switch (cmd) {
  case 'get-state':
    console.log('device')
    break
  case 'devices':
    console.log('List of devices attached')
    console.log('emulator-5554          device product:sdk_gphone64 model:Fake_Phone device:emu64 transport_id:1')
    break
  case 'shell': {
    const script = rest.filter(a => a !== '-T' && a !== '-t').join(' ')
    if (/^getprop /.test(script.split(';')[0].trim())) {
      console.log('Fake_Phone\n14\narm64-v8a\n34\nshell')
      break
    }
    sh(script)
    break
  }
  case 'exec-out':
    sh(rest.join(' '))
    break
  case 'push': {
    const [local, remote] = rest
    const child = spawn('sh', ['-c', `cat > '${remote}'`], { stdio: ['pipe', 'inherit', 'inherit'] })
    fs.createReadStream(local).pipe(child.stdin)
    child.on('close', code => {
      if (code === 0) console.log(`${local}: 1 file pushed`)
      process.exit(code ?? 1)
    })
    break
  }
  case 'pull': {
    const [remote, local] = rest
    const out = fs.createWriteStream(local)
    const child = spawn('sh', ['-c', `cat '${remote}'`], { stdio: ['ignore', 'pipe', 'inherit'] })
    child.stdout.pipe(out)
    child.on('close', code => process.exit(code ?? 1))
    break
  }
  case 'forward':
  case 'reverse':
    if (rest[0] === '--remove') break
    if (rest[0] === 'tcp:0') console.log('45678')
    break
  case 'install':
    console.log('Performing Streamed Install\nSuccess')
    break
  default:
    console.error(`fake adb: unsupported ${cmd}`)
    process.exit(1)
}
