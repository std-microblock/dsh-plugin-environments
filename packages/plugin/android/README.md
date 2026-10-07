# android/dsh-clipboard.jar

The device-side helper the ADB environment pushes to `/data/local/tmp/dsh-clipboard.jar`. It writes
the Android clipboard from the shell user through `app_process`, which is how `type` delivers
non-ASCII text (clipboard + `KEYCODE_PASTE`) without installing an IME — see `typeText` in
[`src/env/adb/adb-env.ts`](../src/env/adb/adb-env.ts).

Only ~4 KiB: everything Android-specific goes through reflection, so it compiles with a plain JDK
and has no `android.jar` dependency. Two routes are tried in order:

1. the public `android.content.ClipboardManager` from the process' system context, patched to report
   `com.android.shell` (the route scrcpy uses through its FakeContext);
2. the private `IClipboard` binder interface, whose trailing parameters (calling package,
   attribution tag, user id, device id) are matched against the signature the device actually has.

## Rebuilding

```sh
pnpm run build:android-helper
```

Needs a JDK (`JAVA_HOME`, or a portable one unpacked under `.cache/tools/jdk`) and D8 — either from
an Android SDK build-tools directory (`ANDROID_HOME`/`ANDROID_SDK_ROOT`) or from an r8 jar in
`.cache/tools` (https://maven.google.com/com/android/tools/r8). The built jar is committed, so this
only has to run after `src/dsh/Clipboard.java` changes.

## Using it on a device

```sh
adb push dsh-clipboard.jar /data/local/tmp/
printf '你好，世界 ✓' | adb shell CLASSPATH=/data/local/tmp/dsh-clipboard.jar app_process / dsh.Clipboard set
adb shell CLASSPATH=/data/local/tmp/dsh-clipboard.jar app_process / dsh.Clipboard get
adb shell CLASSPATH=/data/local/tmp/dsh-clipboard.jar app_process / dsh.Clipboard clear
```

`set` reads UTF-8 from stdin, `get` writes the clipboard to stdout and `clear` empties it. An extra
`binder` argument forces route 2, which is how the fallback was verified.

Verified on Android 16 (OPPO PKM110, SDK 36): both routes set and read CJK plus emoji, and the text
pasted into the focused field with the active IME left untouched. `adb shell input text '你好'` on
the same device fails with a `NullPointerException` from `InputShellCommand.sendText`, which is what
this helper exists to avoid.
