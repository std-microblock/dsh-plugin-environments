// SubprocessRuntime provider that runs a mounted session's processes in an environment.
// The DSH base classes are injected so this module stays loadable outside the harness (tests).
import { PassThrough } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import type {
  SubprocessExecutableNotFoundError as NotFoundError,
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessOutputReader,
  SubprocessRuntime as SubprocessRuntimeBase,
  SubprocessSpawnSpec,
  SubprocessTerminalEnvironment,
  SubprocessTerminalHandle,
  SubprocessTerminalSignal,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import type { Environment } from '../env/environment.ts'
import type { EnvProcess, SpawnSpec } from '../env/types.ts'
import { asPluginContext } from '../host-api.ts'
import type { MountMap } from './map.ts'

/** Tail-keeping collector implementing the offset-based reader contract. */
export class Collector {
  private readonly maxBytes: number
  private readonly chunks: Buffer[] = []
  private size = 0
  private total = 0

  constructor(maxBytes: number) {
    this.maxBytes = maxBytes
  }

  push(buf: Buffer): void {
    this.chunks.push(buf)
    this.size += buf.length
    this.total += buf.length
    while (this.size > this.maxBytes && this.chunks.length > 1) {
      this.size -= this.chunks.shift()?.length ?? 0
    }
  }

  readFrom(fromByte: number): { text: string; nextOffset: number; lossy: boolean } {
    const start = this.total - this.size
    const all = Buffer.concat(this.chunks)
    if (fromByte < start) return { text: all.toString('utf8'), nextOffset: this.total, lossy: true }
    return { text: all.subarray(fromByte - start).toString('utf8'), nextOffset: this.total, lossy: false }
  }
}

export interface EnvSubprocessConfig {
  map: MountMap
}

export interface SubprocessDeps {
  SubprocessRuntime: typeof SubprocessRuntimeBase
  SubprocessExecutableNotFoundError: typeof NotFoundError
}

/** The environment spawn spec derived from a harness spawn spec. */
export type EnvSpawnSpec = SpawnSpec & { argv: string[]; cwd: string; env: Record<string, string | null> }

const OUTPUTS = ['stdout', 'stderr'] as const
type OutputName = (typeof OUTPUTS)[number]

/** Create the EnvSubprocessRuntime class bound to the harness SubprocessRuntime base class. */
export function createEnvSubprocessRuntime({ SubprocessRuntime, SubprocessExecutableNotFoundError }: SubprocessDeps) {
  return class EnvSubprocessRuntime extends SubprocessRuntime {
    static inject = []
    readonly map: MountMap
    readonly env: Environment
    readonly live = new Set<EnvProcess>()

    constructor(ctx: Context, config: EnvSubprocessConfig) {
      super(ctx)
      this.map = config.map
      this.env = config.map.env
      asPluginContext(ctx).effect(
        () => () => {
          for (const p of this.live) p.kill().catch(() => {})
        },
        'environments: mounted processes',
      )
    }

    async resolveExecutable(
      command: string,
      _env?: Readonly<Record<string, string>>,
      signal?: AbortSignal,
    ): Promise<string> {
      if (this.env.path.isAbsolute(command)) {
        const st = await this.env.stat(command, { signal }).catch(() => null)
        if (st?.type === 'file') return command
        throw new SubprocessExecutableNotFoundError(`${command} not found in ${this.env.name}`)
      }
      if (/[\\/]/.test(command))
        throw new SubprocessExecutableNotFoundError(`relative executable paths are not supported: ${command}`)
      const probe =
        this.env.family === 'windows'
          ? { argv: ['where.exe', command] }
          : { argv: ['sh', '-c', `command -v ${JSON.stringify(command)}`] }
      const r = await this.env.exec(probe, { signal }).catch(() => undefined)
      const found =
        r?.code === 0
          ? r.stdout
              .toString()
              .split(/\r?\n/)
              .map(s => s.trim())
              .find(Boolean)
          : undefined
      if (!found) throw new SubprocessExecutableNotFoundError(`${command} not found in ${this.env.name}`)
      return found
    }

    terminalEnvironment(): Promise<SubprocessTerminalEnvironment> {
      const shell = this.env.info?.shell
      return Promise.resolve({
        platform: this.env.family === 'windows' ? 'windows' : 'posix',
        ...(shell ? { defaultShell: shell } : {}),
      })
    }

    /** Map a harness spawn spec into the environment (argv, remote cwd, env with tombstones). */
    spawnSpec(spec: { argv: readonly string[]; cwd: string; env?: NodeJS.ProcessEnv | undefined }): EnvSpawnSpec {
      const env: Record<string, string | null> = {}
      for (const [k, v] of Object.entries(spec.env ?? {})) env[k] = v === undefined ? null : String(v)
      return { argv: [...spec.argv], cwd: this.map.toRemote(spec.cwd), env }
    }

    spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
      if (spec.signal?.aborted) throw new Error('spawn aborted')
      const stdinMode = spec.stdio.stdin
      const stdin = stdinMode === 'pipe' ? new PassThrough() : undefined
      const pipes: Partial<Record<OutputName, PassThrough>> = {}
      const collected: Partial<Record<OutputName, Collector>> = {}
      for (const name of OUTPUTS) {
        const mode = spec.stdio[name]
        if (mode === 'pipe') pipes[name] = new PassThrough()
        else if (typeof mode === 'object') collected[name] = new Collector(mode.maxBytes)
      }
      let proc: EnvProcess | undefined
      let terminated = false
      let resolveDone!: (outcome: SubprocessOutcome) => void
      let rejectDone!: (error: unknown) => void
      const done = new Promise<SubprocessOutcome>((res, rej) => {
        resolveDone = res
        rejectDone = rej
      })
      done.catch(() => {})
      const readers: { stdout?: SubprocessOutputReader; stderr?: SubprocessOutputReader } = {}
      for (const name of OUTPUTS) {
        const c = collected[name]
        if (c) readers[name] = { readFrom: n => c.readFrom(n) }
      }
      const handle: SubprocessHandle = {
        stdin,
        stdout: pipes.stdout,
        stderr: pipes.stderr,
        control: undefined,
        collected: readers,
        done,
        terminate() {
          terminated = true
          proc?.kill().catch(() => {})
        },
        async waitForExit(signal?: AbortSignal) {
          if (!proc) await new Promise(r => setTimeout(r, 10))
          const aborted = new Promise<boolean>(r => signal?.addEventListener('abort', () => r(false), { once: true }))
          return Promise.race([
            done.then(
              () => true,
              () => true,
            ),
            aborted,
          ])
        },
      }
      spec.signal?.addEventListener('abort', () => handle.terminate(), { once: true })
      this.env.spawn(this.spawnSpec(spec)).then(
        p => {
          proc = p
          this.live.add(p)
          if (terminated) p.kill().catch(() => {})
          const outputs: Promise<unknown>[] = []
          for (const name of OUTPUTS) {
            const src = p[name]
            const ended = new Promise(r => {
              src.once('end', r)
              src.once('close', r)
              src.once('error', r)
            })
            outputs.push(ended)
            const pipe = pipes[name]
            const collector = collected[name]
            if (pipe) src.pipe(pipe)
            else if (collector) src.on('data', (d: Buffer) => collector.push(d))
            else src.resume()
          }
          if (stdin) {
            stdin.on('data', (d: Buffer) => {
              stdin.pause()
              p.write(d).then(
                () => stdin.resume(),
                () => stdin.resume(),
              )
            })
            stdin.on('end', () => p.end())
          } else if (typeof stdinMode === 'object') {
            void p.write(Buffer.from(stdinMode.data)).finally(() => p.end())
          } else {
            p.end()
          }
          void p.exited.then(async exit => {
            this.live.delete(p)
            await Promise.race([
              Promise.all(outputs),
              new Promise(r => setTimeout(r, Math.min(spec.graceMs ?? 2000, 5000))),
            ])
            for (const name of OUTPUTS) {
              const pipe = pipes[name]
              if (pipe && !pipe.writableEnded) pipe.end()
            }
            const signal =
              exit.code === null
                ? ((exit.signal && /^SIG/.test(exit.signal) ? exit.signal : 'SIGKILL') as NodeJS.Signals)
                : null
            resolveDone({ exitCode: exit.code, signal })
          })
        },
        (error: unknown) => {
          for (const s of Object.values(pipes)) s.destroy(error instanceof Error ? error : undefined)
          rejectDone(error)
        },
      )
      return handle
    }

    async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
      const env: Record<string, string> = {}
      for (const [k, v] of Object.entries(spec.env ?? {})) env[k] = String(v)
      env['TERM'] = spec.terminalType
      const p = await this.env.spawn(
        { argv: [...spec.argv], cwd: this.map.toRemote(spec.cwd), env, pty: { rows: spec.rows, cols: spec.cols } },
        { signal: spec.signal },
      )
      this.live.add(p)
      const output = new PassThrough()
      p.stdout.pipe(output)
      const done = p.exited.then((exit): SubprocessOutcome => {
        this.live.delete(p)
        return { exitCode: exit.code, signal: exit.code === null ? 'SIGKILL' : null }
      })
      let revision = 0
      return {
        pid: p.pid ?? 0,
        output,
        done,
        async write(data: string) {
          revision++
          await p.write(Buffer.from(data, 'utf8'))
        },
        async resize(cols: number, rows: number) {
          await p.resize(rows, cols)
        },
        inspectForeground() {
          return Promise.resolve(undefined)
        },
        inspectActivity() {
          return Promise.resolve({ state: 'unknown' as const, revision })
        },
        async signalForeground(signal: SubprocessTerminalSignal) {
          if (signal === 'SIGINT') await p.write(Buffer.from('\x03'))
          else await p.kill()
          return p.pid ?? 0
        },
        async terminate() {
          await p.kill()
          await done.catch(() => {})
        },
      }
    }
  }
}

export type EnvSubprocessRuntime = InstanceType<ReturnType<typeof createEnvSubprocessRuntime>>
