#!/usr/bin/env node
// A fake `adb` for tests: runs "device" commands through the local POSIX sh. The bundled
// clipboard helper jar and the `input` command are emulated as well, so `typeText` can be
// exercised without a device: the "device clipboard" is a file and every emulated command is
// appended to a log the tests can assert on.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DEVICE_TMP = path.join(os.tmpdir(), 'fake-adb-device')
const HELPER_REMOTE = '/data/local/tmp/dsh-clipboard.jar'

const deviceFile = name => {
  fs.mkdirSync(DEVICE_TMP, { recursive: true })
  return path.join(DEVICE_TMP, name)
}

const record = line => fs.appendFileSync(deviceFile('log'), `${line}\n`)

let args = process.argv.slice(2)
if (args[0] === '-s') args = args.slice(2)
const [cmd, ...rest] = args

const sh = (script, stdio = 'inherit') => {
  const child = spawn('sh', ['-c', script], { stdio })
  child.on('close', code => process.exit(code ?? 1))
  return child
}

/** Emulate the helper jar; returns false when the script is not a helper invocation. */
function helper(script) {
  const command = /dsh\.Clipboard (set|get|clear)/.exec(script)?.[1]
  if (!command) return false
  const clipboard = path.join(DEVICE_TMP, 'clipboard')
  if (command === 'get') {
    if (fs.existsSync(clipboard)) process.stdout.write(fs.readFileSync(clipboard))
    return true
  }
  if (command === 'clear') {
    fs.rmSync(clipboard, { force: true })
    console.log('ok')
    return true
  }
  const chunks = []
  process.stdin.on('data', c => chunks.push(c))
  process.stdin.on('end', () => {
    const text = Buffer.concat(chunks).toString('utf8')
    fs.mkdirSync(DEVICE_TMP, { recursive: true })
    fs.writeFileSync(clipboard, text)
    record(`clipboard=${text}`)
    console.log('ok')
    process.exit(0)
  })
  return true
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
    if (helper(script)) break
    if (/^\s*input\b/.test(script)) {
      // No `input` command on the host; the tests assert on this log instead.
      record(`input: ${script}`)
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
    const target = remote === HELPER_REMOTE ? deviceFile('dsh-clipboard.jar') : remote
    const child = spawn('sh', ['-c', `cat > '${target}'`], { stdio: ['pipe', 'inherit', 'inherit'] })
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
