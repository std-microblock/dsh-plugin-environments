// Long-running / interactive processes of borrowed environments.
import { StringDecoder } from 'node:string_decoder'
import type { EnvProcess, ExitInfo } from '../../env/types.ts'
import { TEXT_OUTPUT, clip, stripAnsi } from '../common.ts'
import { ENV_PARAM, type EnvToolContext } from './context.ts'

/** Output collector for background processes started through process_start. */
export class ManagedProcess {
  readonly id: string
  readonly proc: EnvProcess
  readonly command: string
  readonly startedAt = Date.now()
  exit: ExitInfo | undefined = undefined
  private buffer = ''
  private total = 0
  private waiters: (() => void)[] = []

  constructor(id: string, proc: EnvProcess, command: string) {
    this.id = id
    this.proc = proc
    this.command = command
    // One decoder per stream so characters split across chunks are not mangled.
    const collect = () => {
      const decoder = new StringDecoder('utf8')
      return (d: Buffer) => {
        const s = decoder.write(d)
        this.buffer += s
        this.total += s.length
        if (this.buffer.length > 1024 * 1024) this.buffer = this.buffer.slice(-512 * 1024)
        this.notify()
      }
    }
    proc.stdout.on('data', collect())
    if (proc.stderr !== proc.stdout) proc.stderr.on('data', collect())
    void proc.exited.then(
      exit => {
        this.exit = exit
        this.notify()
      },
      () => {
        // The connection carrying the process was lost.
        this.exit = { code: null, signal: 'connection lost' }
        this.notify()
      },
    )
  }

  private notify(): void {
    for (const w of this.waiters.splice(0)) w()
  }

  /** Return and clear the buffered output. */
  take(): string {
    const out = this.buffer
    this.buffer = ''
    return out
  }

  waitForOutput(ms: number, signal?: AbortSignal): Promise<void> {
    if (this.buffer.length > 0 || this.exit) return Promise.resolve()
    return new Promise(resolve => {
      const done = () => {
        clearTimeout(t)
        resolve()
      }
      const t = setTimeout(done, ms)
      this.waiters.push(done)
      signal?.addEventListener('abort', done, { once: true })
    })
  }
}

/** Register process_start / process_io / process_kill (the process table lives in each held entry). */
export function addProcessTools({ add, use }: EnvToolContext): void {
  const startTarget = use({ name: 'process_start', gui: false })
  add({
    name: 'process_start',
    description:
      'Start a long-running or interactive program in a borrowed environment without waiting for it. Returns a process id for env_process_io and env_process_kill (with the same environment). Use pty=true for programs that need a terminal. Processes end when the environment is returned or its connection is lost.',
    parameters: {
      ...ENV_PARAM,
      command: { type: 'string', required: true, description: "Command line, interpreted by the environment's shell." },
      cwd: { type: 'string', description: "Working directory (default: the environment's)." },
      pty: { type: 'boolean', description: 'Run inside a pseudo-terminal.' },
      wait_ms: { type: 'integer', description: 'Collect initial output for this long (default 1500).' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const t = await startTarget(exec, args.environment)
      const proc = await t.env.spawn({
        command: args.command,
        cwd: args.cwd ? t.abs(args.cwd) : t.cwd,
        ...(args.pty ? { pty: { rows: 40, cols: 120 } } : {}),
      })
      const id = t.nextProcessId()
      const mp = new ManagedProcess(id, proc, args.command)
      t.processes.set(id, mp)
      await new Promise(r => setTimeout(r, Math.min(30000, args.wait_ms ?? 1500)))
      const out = stripAnsi(mp.take())
      return `process ${id} on ${t.alias} ${mp.exit ? `exited with code ${mp.exit.code}` : 'running'}${proc.pid ? ` (pid ${proc.pid})` : ''}\n${out ? clip(out) : '(no output yet)'}`
    },
  })

  const ioTarget = use({ name: 'process_io', gui: false })
  add({
    name: 'process_io',
    description: 'Send input to and/or read new output from a process started with env_process_start.',
    parameters: {
      ...ENV_PARAM,
      id: { type: 'string', required: true, description: 'Process id, e.g. "p1".' },
      input: { type: 'string', description: 'Text to write to standard input (include "\\n" to press Enter).' },
      close_stdin: { type: 'boolean', description: 'Close standard input after writing.' },
      wait_ms: { type: 'integer', description: 'Wait up to this long for new output (default 1000, max 60000).' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const { processes } = await ioTarget(exec, args.environment)
      const mp = processes.get(args.id)
      if (!mp) throw new Error(`unknown process ${args.id}; known: ${[...processes.keys()].join(', ') || 'none'}`)
      if (args.input !== undefined && !mp.exit) await mp.proc.write(Buffer.from(args.input, 'utf8'))
      if (args.close_stdin) mp.proc.end()
      await mp.waitForOutput(Math.min(60000, args.wait_ms ?? 1000), exec.signal)
      if (!mp.exit) await new Promise(r => setTimeout(r, 150))
      const out = stripAnsi(mp.take())
      return `process ${mp.id}: ${mp.exit ? `exited with code ${mp.exit.code ?? mp.exit.signal}` : 'running'}\n${out ? clip(out) : '(no new output)'}`
    },
  })

  const killTarget = use({ name: 'process_kill', gui: false })
  add({
    name: 'process_kill',
    description: 'Stop a process started with env_process_start (kills its whole process tree).',
    parameters: { ...ENV_PARAM, id: { type: 'string', required: true, description: 'Process id.' } },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const { processes } = await killTarget(exec, args.environment)
      const mp = processes.get(args.id)
      if (!mp) throw new Error(`unknown process ${args.id}`)
      if (!mp.exit) await mp.proc.kill()
      await Promise.race([mp.proc.exited, new Promise(r => setTimeout(r, 3000))])
      processes.delete(args.id)
      return `process ${args.id} stopped`
    },
  })
}
