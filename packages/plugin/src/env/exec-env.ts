// Environment variables that plugins supply for every command an environment starts.
//
// The wire protocol already carries a per-spawn `env` overlay, but only the harness's own
// spawn spec fills it. This registry is the plugin-facing seam: a plugin declares the
// variables it may supply, and every process a mounted session or a borrowed environment
// starts receives the values resolved for the calling agent.
import type { Agent, Dispose, PluginContext } from '../host-api.ts'

/** Declared metadata of one variable a contributor may supply. */
export interface ExecEnvVariable {
  /** Concise description of the fact the variable carries. */
  description: string
}

/**
 * One plugin's contribution to the environment of every command an environment starts.
 * Declared names make ownership conflicts detectable before the first command; `resolve`
 * computes only the values available for the current agent.
 */
export interface ExecEnvContributor {
  /** Stable contributor name used in diagnostics and duplicate detection. */
  name: string
  /** Complete set of variable names this contributor may return. */
  variables: Readonly<Record<string, ExecEnvVariable>>
  /**
   * Resolve this contributor's values for one agent.
   * @param agent - the agent whose command is starting, when the caller has one.
   * @returns a partial map whose keys are all declared in {@link variables}; `undefined`
   *   leaves the variable to the environment's own value.
   */
  resolve(agent: Agent | undefined): Readonly<Record<string, string | undefined>>
}

/** One enumerable declaration returned by {@link ExecEnvRegistry.list}. */
export interface ExecEnvInfo extends ExecEnvVariable {
  /** Contributor that owns the variable. */
  contributor: string
  /** Declared environment variable name. */
  name: string
}

/** Environment variable names the platform allows: a POSIX name without `=`. */
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Registry of plugin-supplied command environment variables, provided to other plugins as
 * `ctx.execEnv`. Registrations are owned by the calling plugin's fiber: disposing it
 * removes the variables from every command started afterwards.
 */
export class ExecEnvRegistry {
  private readonly ctx: PluginContext
  private readonly contributors = new Map<string, ExecEnvContributor>()
  private readonly owners = new Map<string, string>()

  constructor(ctx: PluginContext) {
    this.ctx = ctx
  }

  /**
   * Register one contributor. Names and variable names are unique; registration is disposed
   * with the calling plugin fiber.
   * @param contributor - declared names and the per-agent resolver.
   * @returns the disposer that unregisters the contribution.
   */
  register(contributor: ExecEnvContributor): Dispose {
    const dispose = this.ctx.effect(() => {
      if (contributor.name.trim().length === 0) {
        throw new Error('exec env contributor name must be non-empty')
      }
      if (this.contributors.has(contributor.name)) {
        throw new Error(`exec env contributor "${contributor.name}" is already registered`)
      }
      for (const [name, variable] of Object.entries(contributor.variables)) {
        if (!VARIABLE_NAME.test(name)) {
          throw new Error(`exec env contributor "${contributor.name}" declared invalid name "${name}"`)
        }
        if (variable.description.trim().length === 0) {
          throw new Error(`exec env contributor "${contributor.name}" must describe "${name}"`)
        }
        const owner = this.owners.get(name)
        if (owner !== undefined) {
          throw new Error(`exec env variable "${name}" is already owned by contributor "${owner}"; contributor "${contributor.name}" cannot also own it`)
        }
      }
      this.contributors.set(contributor.name, contributor)
      for (const name of Object.keys(contributor.variables)) this.owners.set(name, contributor.name)
      return () => {
        this.contributors.delete(contributor.name)
        for (const name of Object.keys(contributor.variables)) {
          if (this.owners.get(name) === contributor.name) this.owners.delete(name)
        }
      }
    }, `execEnv.register(${JSON.stringify(contributor.name)})`)
    return () => void dispose()
  }

  /**
   * Resolve the overlay for one command. Later contributors win over earlier ones by name
   * order, so the result does not depend on registration order.
   * @param agent - the agent whose command is starting, when the caller has one.
   * @returns the variables to merge into the command's environment.
   */
  collect(agent: Agent | undefined): Record<string, string> {
    const values: Record<string, string> = {}
    for (const contributor of [...this.contributors.values()].sort((left, right) => left.name.localeCompare(right.name))) {
      for (const [name, value] of Object.entries(contributor.resolve(agent))) {
        if (!Object.hasOwn(contributor.variables, name)) {
          throw new Error(`exec env contributor "${contributor.name}" returned undeclared name "${name}"`)
        }
        if (value === undefined) continue
        if (typeof value !== 'string') {
          throw new Error(`exec env contributor "${contributor.name}" returned a non-string value for "${name}"`)
        }
        if (value.includes('\u0000')) {
          throw new Error(`exec env contributor "${contributor.name}" returned a value with a NUL byte for "${name}"`)
        }
        values[name] = value
      }
    }
    return values
  }

  /**
   * Enumerate the declared variables without running their resolvers.
   * @returns declarations sorted by variable name.
   */
  list(): ExecEnvInfo[] {
    return [...this.contributors.values()]
      .flatMap(contributor => Object.entries(contributor.variables).map(([name, variable]) => ({
        contributor: contributor.name,
        description: variable.description,
        name,
      })))
      .sort((left, right) => left.name.localeCompare(right.name))
  }
}

/**
 * Create the registry and publish it as `ctx.execEnv`.
 * @param ctx - the plugin context that owns the service and every registration below it.
 * @returns the registry other plugins register their variables with.
 */
export function installExecEnv(ctx: PluginContext): ExecEnvRegistry {
  const registry = new ExecEnvRegistry(ctx)
  ctx.effect(() => ctx.provide('execEnv', registry), 'environments: exec env registry')
  return registry
}
