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
  dpad_center: 23,
  volume_up: 24,
  volume_down: 25,
  power: 26,
  camera: 27,
  clear: 28,
  comma: 55,
  period: 56,
  alt: 57,
  alt_left: 57,
  alt_right: 58,
  shift: 59,
  shift_left: 59,
  shift_right: 60,
  tab: 61,
  space: 62,
  explorer: 64,
  envelope: 65,
  enter: 66,
  return: 66,
  del: 67,
  backspace: 67,
  minus: 69,
  equals: 70,
  slash: 76,
  at: 77,
  menu: 82,
  notification: 83,
  notifications: 83,
  search: 84,
  media_play_pause: 85,
  playpause: 85,
  media_stop: 86,
  media_next: 87,
  media_previous: 88,
  page_up: 92,
  pageup: 92,
  page_down: 93,
  pagedown: 93,
  escape: 111,
  esc: 111,
  delete: 112,
  forward_del: 112,
  ctrl: 113,
  control: 113,
  ctrl_left: 113,
  ctrl_right: 114,
  caps_lock: 115,
  meta: 117,
  meta_left: 117,
  win: 117,
  cmd: 117,
  meta_right: 118,
  move_home: 122,
  move_end: 123,
  insert: 124,
  volume_mute: 164,
  mute: 164,
  app_switch: 187,
  recent: 187,
  recents: 187,
  overview: 187,
  sleep: 223,
  wakeup: 224,
  wake: 224,
  assist: 219,
  brightness_down: 220,
  brightness_up: 221,
  paste: 279,
  copy: 278,
  cut: 277,
  all_apps: 284,
}

/**
 * Key name → argument of `input keyevent` (a numeric code or a KEYCODE_ name). Single letters
 * and digits are those keys; numbers with two or more digits are raw key codes.
 */
export function androidKey(key: unknown): string | number {
  const k = String(key)
    .trim()
    .toLowerCase()
    .replace(/^keycode_/, '')
  if (/^\d$/.test(k)) return 7 + Number(k)
  if (/^\d{2,3}$/.test(k)) return Number(k)
  if (/^[a-z]$/.test(k)) return 29 + k.charCodeAt(0) - 97
  const code = KEYS[k]
  if (code !== undefined) return code
  const fn = /^f([1-9]|1[0-2])$/.exec(k)
  if (fn) return 130 + Number(fn[1])
  return `KEYCODE_${k.toUpperCase()}`
}
