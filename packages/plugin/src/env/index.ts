// Environment barrel: the abstraction plus every implementation and factory.
export {
  Environment,
  unsupported,
  type EnvironmentDescription,
  type EnvironmentEvents,
  type EnvironmentOptions,
} from './environment.ts'
export type * from './types.ts'
export { HostEnvironment } from './host-env.ts'
export { HostChildProcess, runHost, type RunHostOptions, type RunHostResult } from './host-process.ts'
export * as posixShell from './posix-shell.ts'
export { ServerEnvironment, normalizeInfo, type ServerEnvironmentOptions } from './server/server-env.ts'
export { ServerProcess } from './server/server-process.ts'
export {
  openLocal,
  openServer,
  serverBinary,
  startServeProcess,
  SERVER_EXE,
  type OpenLocalOptions,
  type OpenServerOptions,
  type ServeProcess,
  type ServeProcessOptions,
} from './server/connect.ts'
export { AdbEnvironment, type AdbEnvironmentOptions, type AndroidInfo, type InstallApkOptions } from './adb/adb-env.ts'
export { listAdbDevices, type AdbCommand, type AdbDevice } from './adb/devices.ts'
export { openSsh, type OpenSshOptions } from './ssh/open.ts'
export { SshEnvironment } from './ssh/ssh-env.ts'
export { sshConnectConfig, type SshConfig } from './ssh/connection.ts'
export { walkGlob } from './ssh/walk-glob.ts'
export {
  ACCOUNT_RE,
  createWindowsAccount,
  deleteWindowsAccount,
  grantWindowsAccount,
  listWindowsAccounts,
  type WindowsAccount,
} from './winuser/accounts.ts'
export { openWindowsAccount, sharedBinary, type WinuserConfig } from './winuser/winuser-env.ts'
