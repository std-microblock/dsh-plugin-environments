// Android key names accepted by the input tool, mapped to `input keyevent` codes.
const KEYS: Record<string, number> = {
  home: 3,
  back: 4,
  call: 5,
  endcall: 6,
  up: 19,
  down: 20,
  left: 21,
  right: 22,
  center: 23,
  volume_up: 24,
  volume_down: 25,
  power: 26,
  camera: 27,
  clear: 28,
  tab: 61,
  space: 62,
  enter: 66,
  del: 67,
  backspace: 67,
  delete: 112,
  menu: 82,
  search: 84,
  app_switch: 187,
  recent: 187,
  escape: 111,
  esc: 111,
  page_up: 92,
  page_down: 93,
  move_home: 122,
  move_end: 123,
  wakeup: 224,
  sleep: 223,
}

/** Key name → argument of `input keyevent` (a numeric code or a KEYCODE_ name). */
export function androidKey(key: unknown): string | number {
  const k = String(key)
    .toLowerCase()
    .replace(/^keycode_/, '')
  if (/^\d+$/.test(k)) return k
  const code = KEYS[k]
  if (code !== undefined) return code
  return `KEYCODE_${k.toUpperCase()}`
}
