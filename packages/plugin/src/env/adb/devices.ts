// adb CLI invocation and device discovery.
import { runHost } from '../host-process.ts'

/** An adb executable: a path, or `[executable, ...leading args]` (tests use `[node, fake-adb.mjs]`). */
export type AdbCommand = string | readonly string[]

export function adbCommand(adb: AdbCommand): { exe: string; prefix: string[] } {
  const [exe = 'adb', ...prefix] = typeof adb === 'string' ? [adb] : adb
  return { exe, prefix }
}

/** One line of `adb devices -l`. */
export interface AdbDevice {
  serial: string
  state: string
  model: string | undefined
  product: string | undefined
  device: string | undefined
  transportId: string | undefined
  emulator: boolean
}

/** List devices known to adb. */
export async function listAdbDevices(adb: AdbCommand = 'adb'): Promise<AdbDevice[]> {
  const { exe, prefix } = adbCommand(adb)
  const { stdout } = await runHost(exe, [...prefix, 'devices', '-l'], { timeoutMs: 15000 })
  const devices: AdbDevice[] = []
  for (const line of stdout.toString().split(/\r?\n/).slice(1)) {
    const m = /^(\S+)\s+(\S+)(.*)$/.exec(line.trim())
    if (!m) continue
    const [, serial = '', state = '', rest = ''] = m
    const props = Object.fromEntries([...rest.matchAll(/(\w+):(\S+)/g)].map(x => [x[1], x[2]])) as Record<
      string,
      string | undefined
    >
    devices.push({
      serial,
      state,
      model: props['model'],
      product: props['product'],
      device: props['device'],
      transportId: props['transport_id'],
      emulator: serial.startsWith('emulator-'),
    })
  }
  return devices
}
