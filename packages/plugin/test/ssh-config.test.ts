import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import ssh2 from 'ssh2'
import { sshConnectConfig } from '../src/env/ssh/connection.ts'
import {
  expandProxyTokens,
  openProxy,
  parseSshG,
  proxyJumpArgs,
  type ProxyDestination,
  type SshTarget,
} from '../src/env/ssh/ssh-config.ts'

/** Abridged `ssh -G buildbox` output. */
const SAMPLE = `User alice
hostname 10.0.0.5
port 2222
identityfile ~/.ssh/id_rsa
identityfile ~/.ssh/id_ed25519
proxyjump jump
proxycommand none
forwardagent yes
`

const dest: ProxyDestination = { alias: 'buildbox', host: '10.0.0.5', port: 2222, user: 'alice' }

function target(patch: Partial<SshTarget> = {}): SshTarget {
  return { host: '10.0.0.5', port: 2222, user: 'alice', identityFiles: [], ...patch }
}

test('ssh -G output is parsed', () => {
  assert.deepEqual(parseSshG(SAMPLE), {
    host: '10.0.0.5',
    port: 2222,
    user: 'alice',
    identityFiles: [path.join(os.homedir(), '.ssh', 'id_rsa'), path.join(os.homedir(), '.ssh', 'id_ed25519')],
    proxyJump: 'jump',
  })
  assert.equal(parseSshG('hostname h\nproxycommand ssh -W %h:%p jump\n')?.proxyCommand, 'ssh -W %h:%p jump')
  assert.equal(parseSshG('port 22\nuser someone\n'), undefined)
})

test('the environment overrides the resolved config', t => {
  const key = path.join(os.tmpdir(), `dsh-key-${process.pid}`)
  fs.writeFileSync(key, 'key')
  t.after(() => fs.rmSync(key, { force: true }))
  const resolved = target({ identityFiles: [key + '.absent', key] })

  const filled = sshConnectConfig({ host: 'buildbox' }, resolved)
  assert.equal(filled.host, '10.0.0.5')
  assert.equal(filled.port, 2222)
  assert.equal(filled.username, 'alice')
  assert.equal(String(filled.privateKey), 'key')

  assert.equal(sshConnectConfig({ host: 'buildbox', port: 0 }, resolved).port, 2222)

  const explicit = sshConnectConfig({ host: 'buildbox', port: 22, username: 'bob', password: 'secret' }, resolved)
  assert.equal(explicit.port, 22)
  assert.equal(explicit.username, 'bob')
  assert.equal(explicit.privateKey, undefined)
})

test('ProxyCommand tokens are expanded', () => {
  assert.equal(expandProxyTokens('nc %h %p', dest), 'nc 10.0.0.5 2222')
  assert.equal(expandProxyTokens('ssh -l %r %n 100%%', dest), 'ssh -l alice buildbox 100%')
})

test('a ProxyJump chain tunnels through its last hop', () => {
  const w = ['-o', 'BatchMode=yes', '-W', '10.0.0.5:2222']
  assert.deepEqual(proxyJumpArgs('jump', dest), [...w, 'jump'])
  assert.deepEqual(proxyJumpArgs('bob@jump:2200', dest), [...w, '-l', 'bob', '-p', '2200', 'jump'])
  assert.deepEqual(proxyJumpArgs('a, [::1]:2200', dest), [...w, '-J', 'a', '-p', '2200', '::1'])
  assert.deepEqual(proxyJumpArgs('a,ssh://b:2200', dest), [...w, '-J', 'a', 'ssh://b:2200'])
})

/** A ProxyCommand that relays its stdio to a local TCP port, like `nc 127.0.0.1 <port>`. */
function relayCommand(port: number): string {
  const script = `const s=require('net').connect(${port},'127.0.0.1');process.stdin.pipe(s).pipe(process.stdout)`
  return `"${process.execPath}" -e "${script}"`
}

/** Connect like `connectClient` does, with the proxy's reason appended to a failure. */
function connectThrough(proxyCommand: string): Promise<ssh2.Client> {
  const proxy = openProxy(target({ proxyCommand }), dest)
  assert.ok(proxy)
  const conn = new ssh2.Client()
  return new Promise((resolve, reject) => {
    conn.once('ready', () => resolve(conn))
    conn.once('error', e => {
      proxy.kill()
      void proxy.closed.then(reason => reject(new Error(`${e.message} (${reason})`)))
    })
    conn.once('close', () => proxy.kill())
    conn.connect({ username: 'tester', password: 'secret', readyTimeout: 10_000, sock: proxy.sock })
  })
}

test('ssh2 connects through a ProxyCommand', async t => {
  const server = new ssh2.Server({ hostKeys: [ssh2.utils.generateKeyPairSync('ed25519').private] }, client => {
    client.on('authentication', ctx => ctx.accept())
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const { port } = server.address() as { port: number }

  const conn = await connectThrough(relayCommand(port))
  conn.end()
})

test('a failed proxy explains the connection error', async () => {
  await assert.rejects(
    connectThrough(`"${process.execPath}" -e "console.error('no route to buildbox'); process.exit(1)"`),
    /no route to buildbox/,
  )
})
