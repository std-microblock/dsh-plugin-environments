// Compile packages/plugin/android/src into packages/plugin/android/dsh-clipboard.jar — the tiny
// device-side clipboard helper that the ADB environment pushes to /data/local/tmp.
//
//   node scripts/build-android-helper.ts
//
// The jar is committed, so this only has to run after Clipboard.java changes. It needs a JDK
// (JAVA_HOME, or a portable one unpacked under .cache/tools/jdk) plus D8, taken from either an
// Android SDK build-tools directory (ANDROID_HOME/ANDROID_SDK_ROOT) or an r8 jar dropped into
// .cache/tools (https://maven.google.com/com/android/tools/r8).
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { ROOT } from './server-targets.ts'

const SOURCE = path.join(ROOT, 'packages', 'plugin', 'android', 'src', 'dsh', 'Clipboard.java')
const OUT_JAR = path.join(ROOT, 'packages', 'plugin', 'android', 'dsh-clipboard.jar')
const WORK = path.join(ROOT, '.cache', 'android-helper')
const WIN = process.platform === 'win32'

function exists(file: string | undefined): file is string {
  return !!file && fs.existsSync(file)
}

function firstMatch(dir: string, match: (name: string) => boolean): string | undefined {
  if (!fs.existsSync(dir)) return undefined
  for (const name of fs.readdirSync(dir).sort().reverse()) {
    const full = path.join(dir, name)
    if (match(name) && fs.statSync(full).isFile()) return full
  }
  return undefined
}

function globDir(dir: string, match: (name: string) => boolean): string | undefined {
  if (!fs.existsSync(dir)) return undefined
  for (const name of fs.readdirSync(dir).sort().reverse()) {
    const full = path.join(dir, name)
    if (match(name) && fs.statSync(full).isDirectory()) return full
  }
  return undefined
}

function tool(name: string): string | undefined {
  const exe = WIN ? `${name}.exe` : name
  const javaHome = process.env.JAVA_HOME
  if (exists(javaHome) && exists(path.join(javaHome, 'bin', exe))) return path.join(javaHome, 'bin', exe)
  const portable = globDir(path.join(ROOT, '.cache', 'tools', 'jdk'), () => true)
  if (portable && exists(path.join(portable, 'bin', exe))) return path.join(portable, 'bin', exe)
  return undefined
}

function run(cmd: string, args: string[]): void {
  const result = spawnSync(cmd, args, { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${cmd} exited with ${result.status}`)
}

function d8Command(java: string): string[] {
  const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT
  const buildTools = sdk ? globDir(path.join(sdk, 'build-tools'), () => true) : undefined
  const script = buildTools ? firstMatch(buildTools, n => n === (WIN ? 'd8.bat' : 'd8')) : undefined
  if (script) return [script]
  for (const dir of [path.join(ROOT, '.cache', 'tools')]) {
    const r8 =
      firstMatch(dir, n => /^r8.*\.jar$/.test(n) && !/alpha|beta|rc|dev/.test(n)) ??
      firstMatch(dir, n => /^r8.*\.jar$/.test(n))
    if (r8) return [java, '-cp', r8, 'com.android.tools.r8.D8']
  }
  throw new Error('D8 not found: install Android SDK build-tools (ANDROID_HOME) or drop an r8 jar into .cache/tools')
}

const javac = tool('javac')
const jar = tool('jar')
const java = tool('java')
if (!javac || !jar || !java) throw new Error('no JDK found: set JAVA_HOME or unpack one under .cache/tools/jdk')

fs.rmSync(WORK, { recursive: true, force: true })
const classes = path.join(WORK, 'classes')
const dex = path.join(WORK, 'dex')
fs.mkdirSync(classes, { recursive: true })
fs.mkdirSync(dex, { recursive: true })

// --release 8 keeps the class files readable by D8 on every device we support; -Xlint:-options
// silences the "target 8 is obsolete" note.
run(javac, ['-encoding', 'UTF-8', '-Xlint:-options', '--release', '8', '-d', classes, SOURCE])
const [d8 = '', ...d8Args] = d8Command(java)
run(d8, [...d8Args, '--release', '--min-api', '21', '--output', dex, path.join(classes, 'dsh', 'Clipboard.class')])
run(jar, ['--create', '--file', OUT_JAR, '-C', dex, 'classes.dex'])

console.log(`${path.relative(ROOT, OUT_JAR)} written (${fs.statSync(OUT_JAR).size} bytes)`)
