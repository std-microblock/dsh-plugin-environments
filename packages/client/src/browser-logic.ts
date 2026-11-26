/**
 * Pure decisions of the remote directory browser, kept out of the component so
 * the path bar / create button handshake can be tested without React.
 */

export interface PathBarIntent {
  /** Directory the create / pick action may use as-is (already loaded). */
  path?: string
  /** Directory the browser still has to load and verify before the action runs. */
  load?: string
}

/** Last segment of a posix or Windows path. */
export function baseName(p: string): string {
  const parts = String(p)
    .split(/[\\/]+/)
    .filter(Boolean)
  return parts[parts.length - 1] ?? p
}

/**
 * Reconcile the editable path bar with the loaded listing.
 *
 * The path bar is what the user is looking at, so an unsubmitted path always
 * wins: it has to be loaded (and its resolved path used) instead of silently
 * falling back to the previously loaded directory.
 */
export function pathBarIntent(input: { pathText: string; currentDir?: string | undefined }): PathBarIntent {
  const typed = input.pathText.trim()
  if (typed && typed !== input.currentDir) return { load: typed }
  if (input.currentDir) return { path: input.currentDir }
  return {}
}

/** Whether the create / pick buttons may run right now. */
export function actionBlocked(input: {
  busy: boolean
  loading: boolean
  pathText: string
  currentDir?: string | undefined
}): boolean {
  if (input.busy || input.loading) return true
  const intent = pathBarIntent(input)
  return !intent.path && !intent.load
}

/**
 * Workspace title for a directory when the user did not type one: last path
 * segment plus the environment name.
 */
export function derivedWorkspaceTitle(dir: string | undefined, envName: string | undefined): string {
  if (!dir || !envName) return ''
  return `${baseName(dir)} @ ${envName}`
}
