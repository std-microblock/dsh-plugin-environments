# Building `dsh-env-server`

The server (`crates/dsh-env-server`) ships as a prebuilt binary for five targets
inside the plugin package, so binary size matters. This document lists the CI
build commands, the size budget and the design choices that keep it small.

| package dir    | Rust target                  | built on            |
| -------------- | ---------------------------- | ------------------- |
| `win32-x64`    | `x86_64-pc-windows-msvc`     | Windows (MSVC)      |
| `linux-x64`    | `x86_64-unknown-linux-musl`  | any host (rust-lld) |
| `linux-ia32`   | `i686-unknown-linux-musl`    | any host (rust-lld) |
| `linux-arm64`  | `aarch64-unknown-linux-musl` | any host (rust-lld) |
| `darwin-arm64` | `aarch64-apple-darwin`       | macOS (Xcode SDK)   |

All commands below run from `crates/dsh-env-server/`. That directory's
`.cargo/config.toml` is only picked up when cargo runs from there (or below), so
do not use `--manifest-path` from the repo root.

## Toolchains

```sh
# stable (required)
rustup target add x86_64-pc-windows-msvc x86_64-unknown-linux-musl \
  i686-unknown-linux-musl aarch64-unknown-linux-musl aarch64-apple-darwin

# nightly (optional, for the smaller `dist` build)
rustup toolchain install nightly --profile minimal -c rust-src   # CI: the pinned one, see below
rustup target add --toolchain nightly x86_64-unknown-linux-musl \
  i686-unknown-linux-musl aarch64-unknown-linux-musl aarch64-apple-darwin
```

The nightly musl targets are still needed with `-Zbuild-std`: std is rebuilt from
`rust-src`, but the self-contained musl `libc.a`/CRT objects come from the
target's `rust-std` component.

Linux targets are fully static musl binaries linked with the bundled `rust-lld`
(configured in `.cargo/config.toml`), so no cross gcc/sysroot is needed on any
host. If you build from another directory, set the equivalent env vars:
`CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER=rust-lld` (and `..._I686_...`,
`..._AARCH64_...`).

## Stable build (always supported)

```sh
cargo build --release --target <triple>
# -> target/<triple>/release/dsh-env-server[.exe]
```

`[profile.release]` uses `opt-level = "z"`, fat LTO, one codegen unit,
`panic = "abort"` and `strip = true`. `opt-level = "s"` was measured and is
larger (stable release: linux x64 2650 → 2766 KiB, win x64 2404 → 2596 KiB;
nightly dist linux x64 1764 → 1966 KiB), so `z` stays.

The three Linux musl targets additionally get (`.cargo/config.toml`,
`target.<triple>.rustflags`, stable flags, used by both builds):

- `-Crelocation-model=static`: a plain static executable instead of static-pie;
  drops the runtime relocation table (`.rela.dyn`) and most of `.data.rel.ro`
  (−178 KiB on linux x64 dist).
- `-Cforce-unwind-tables=no`: with `panic = "abort"` nothing unwinds, so
  `.eh_frame` is dead weight (−269 KiB on linux x64 dist). Windows x64 and macOS
  require unwind tables, so these targets keep them.

## Nightly `dist` build (recommended for CI, ~20–35 % smaller)

```sh
cargo +nightly dist --target <triple>
# -> target/<triple>/dist/dsh-env-server[.exe]
```

`dist` is a cargo alias (`.cargo/config.toml`) for:

```sh
cargo +nightly build --profile dist --target <triple> \
  -Zbuild-std=std,panic_abort \
  -Zbuild-std-features=optimize_for_size \
  --config "target.'cfg(all())'.rustflags=['-Zunstable-options','-Cpanic=immediate-abort']"
```

- `-Zbuild-std` rebuilds std with the release profile (opt-level z, LTO across std).
- `optimize_for_size` selects smaller std algorithms (sorting, formatting
  helpers); behaviour is identical. Worth ~20 KiB on top of the rest.
- `-Cpanic=immediate-abort` (the current spelling; it replaced the old
  `-Zbuild-std-features=panic_immediate_abort`) removes the panic message /
  formatting / backtrace machinery. A panic now aborts immediately **without
  printing a message**. The server is written not to panic in normal operation;
  errors are reported through the protocol.
- The flags go into `target.'cfg(all())'.rustflags`, not `build.rustflags`:
  cargo ignores `build.rustflags` as soon as a `target.*.rustflags` entry
  applies (the musl size flags above), while `target.<cfg>` and
  `target.<triple>` entries are joined.
- Do not set `RUSTFLAGS` in the environment for this build: it overrides all of
  the above and silently drops `immediate-abort` and the musl size flags.
- `profile.dist` inherits `release` unchanged; it only exists so dist artifacts
  land in a separate directory.

Measured and not used (linux x64 dist, relative to the shipped configuration,
1764 KiB / brotli 676 KiB):

| flag                                          |   raw | brotli | why not                                                     |
| --------------------------------------------- | ----: | -----: | ----------------------------------------------------------- |
| `-Zfmt-debug=none`                            | −33 K |  −13 K | changes every `{:?}` output, including dependencies' errors |
| `-Cllvm-args=-enable-machine-outliner=always` | −36 K |  +37 K | the shipped artifact is brotli-compressed                   |
| `-Clink-arg=--icf=all` (rust-lld)             | −11 K |   −1 K | negligible                                                  |
| `-Zlocation-detail=none`                      |     0 |      0 | nothing left once immediate-abort is on                     |

The alias is inert on stable — plain `cargo build --release` keeps working.

The nightly is pinned in **`scripts/dist-toolchain.txt`** (currently
`nightly-2026-10-06`, i.e. rustc 1.101.0-nightly 2026-10-05, the one these numbers
were measured with), since `-Z` flags can change. CI and `scripts/build-server.ts`
read it from there; it is the only place to change it.

```sh
rustup toolchain install nightly-2026-10-06 --profile minimal -c rust-src \
  -t x86_64-pc-windows-msvc,x86_64-unknown-linux-musl,i686-unknown-linux-musl,aarch64-unknown-linux-musl
```

### Per-target commands (CI)

CI (`.github/workflows/build.yml`) builds each target on its own runner with the
build script, which runs `cargo +<pinned nightly> dist --locked --target <triple>`
from the crate directory (with `RUSTFLAGS` cleared) and stages the result as
`<out>/<target>/dsh-env-server[.exe]`:

```sh
node scripts/build-server.ts --dist --target win32-x64 --out bin     # windows runner (MSVC)
node scripts/build-server.ts --dist --target linux-x64 --out bin     # ubuntu (rust-lld)
node scripts/build-server.ts --dist --target linux-ia32 --out bin    # ubuntu (rust-lld)
node scripts/build-server.ts --dist --target linux-arm64 --out bin   # ubuntu (rust-lld)
node scripts/build-server.ts --dist --target darwin-arm64 --out bin  # macos-15 (arm64)
```

`--fallback` (used by CI, not by releases) falls back to the stable
`cargo build --release` with a warning annotation if the nightly build fails, so
a broken nightly cannot block development but can never silently produce a
bigger release. Without `--dist` the script does the stable build directly
(output under `release/` instead of `dist/`). Locally, `pnpm build:server:dist`
(default targets: host + the three Linux musl targets) stages into
`packages/plugin/bin/`.

The release package stores each binary Brotli-compressed
(`bin/<target>/dsh-env-server[.exe].br`, quality 11, 16 MiB window;
`scripts/package.ts`), which `packages/plugin/src/server-binary.ts` unpacks into
`~/.dsh/cache/dsh-plugin-environments/bin/<target>-<hash>/` on first use.

## Sizes

Measured 2026-10-07 with rustc 1.98.1 stable / 1.101.0-nightly (2026-10-05),
brotli quality 11, window 24 (node `zlib`). "master" is commit `75045e5`
(in-tree CLI parser, walker, grep, PNG/base64 code); "libraries" is the current
build (clap, anyhow, ignore/globset/grep-\*, base64, png) with the musl size
flags above.

| target      | build          | master raw | libraries raw | master brotli | libraries brotli |
| ----------- | -------------- | ---------: | ------------: | ------------: | ---------------: |
| win x64     | stable release |    946 KiB |      2404 KiB |       384 KiB |          884 KiB |
| win x64     | nightly dist   |    650 KiB |  **1938 KiB** |       281 KiB |      **731 KiB** |
| linux x64   | stable release |   1190 KiB |      2650 KiB |       473 KiB |          964 KiB |
| linux x64   | nightly dist   |    702 KiB |  **1764 KiB** |       292 KiB |      **676 KiB** |
| linux i686  | stable release |   1144 KiB |      2357 KiB |       491 KiB |          946 KiB |
| linux i686  | nightly dist   |    678 KiB |  **1579 KiB** |       301 KiB |      **671 KiB** |
| linux arm64 | stable release |   1028 KiB |      2346 KiB |       437 KiB |          927 KiB |
| linux arm64 | nightly dist   |    616 KiB |  **1513 KiB** |       276 KiB |      **669 KiB** |

For reference, master with the musl size flags would be 554 KiB (brotli 254 KiB)
on linux x64 dist; without them the libraries build is 2210 KiB (brotli 765 KiB).

macOS arm64 is only type-checked from Windows (`cargo check --target
aarch64-apple-darwin`, stable and nightly build-std); linking needs the Apple
SDK, so build it on a macOS runner.

Where the bytes go (linux x64, `cargo bloat --crates`, `.text` of the stable
release build): std 411 KiB, `regex-automata` 303 KiB, tokio 153 KiB, the server
itself 144 KiB, `aho-corasick` 123 KiB, `clap_builder` 107 KiB, `regex-syntax`
104 KiB, `globset` + `ignore` + `walkdir` 68 KiB, `encoding_rs` 26 KiB (+ ~115 KiB
of CJK tables in `.rodata`; `grep-searcher` always links it, we only need its
UTF-16 BOM transcoding), plus ~360 KiB of Unicode tables in `.rodata`.

The regex stack cannot be trimmed through our own `Cargo.toml`: `grep-regex`
depends on `regex-automata` / `regex-syntax` with their default features (full
DFA compiler and every Unicode table), and cargo features are additive. Measured
with a locally patched `grep-regex` (not used, would need a fork or an upstream
change): without the full DFA (`dfa-build`) linux x64 dist is 1696 KiB / brotli
649 KiB (−68 / −27 KiB); additionally limiting Unicode data to
`unicode-case` + `unicode-perl` (still Unicode-correct `ignoreCase`, `\w`, `\d`,
`\s`, but no `\p{Script}` classes) gives 1465 KiB / brotli 624 KiB.

## Dependencies

Established crates, feature-trimmed where the crate allows it:

| purpose                             | crates                                                                                               |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------- |
| async runtime                       | `tokio` (current-thread runtime; `rt net io-util io-std process time sync fs macros`)                |
| protocol                            | `serde_json` (no default features)                                                                   |
| CLI                                 | `clap` derive (`std help usage error-context`; no colour, suggestions or help wrapping)              |
| errors                              | `anyhow` (no default features, so no backtrace capture) for CLI / setup paths; `OpError` on the wire |
| `fs.glob` / `fs.grep`               | `ignore` (WalkBuilder), `globset`, `grep-regex`, `grep-searcher`, `grep-matcher` (ripgrep)           |
| secure channel, WebSocket handshake | `aes-gcm`, `hkdf`, `hmac`, `sha2`, `sha1` (RustCrypto), `getrandom`, `base64`                        |
| screenshots (Windows only)          | `png`                                                                                                |
| OS APIs                             | `libc`, `windows-sys`                                                                                |

Errors: anything that ends up in a `res` / `close` frame is a typed
`protocol::OpError` with a protocol code (`ENOENT`, `EACCES`, `EINVAL`, ...;
`From<io::Error>` maps the kinds). Everything else — CLI commands, listener /
secret setup, `winuser` — uses `anyhow::Result` with `.context(...)` and is printed
with `{:#}` (the whole context chain).

WebSocket framing and the secure channel stay in-tree (`src/ws.rs`,
`src/secure.rs`); there is no TLS (`rustls`/`tungstenite` would cost several
hundred KiB). The PTY layer is also in-tree, see below.

## PTY

`src/pty.rs` exposes the same small interface on both platforms (spawn with
rows/cols, read/write master, resize, kill, wait).

**Unix (Linux, macOS)**: `openpty()` from libc with the initial `winsize`; the
child gets the slave as stdin/stdout/stderr, calls `setsid()` and
`TIOCSCTTY` in `pre_exec`, so it is a session leader with a controlling
terminal (job control works, `tty` reports `/dev/pts/N`). Resize is
`TIOCSWINSZ` on the master (the kernel delivers `SIGWINCH`). The `openpty`
`winsize` argument is `*const` on Linux/musl and `*mut` on macOS; the call
passes `&raw mut ws`, which satisfies both.

**Windows**: ConPTY (`CreatePseudoConsole`) with pipes, child started via
`STARTUPINFOEX` + `PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE`, created suspended so it
is assigned to a job object before it runs (`kill` terminates the whole tree).
Resize is `ResizePseudoConsole`; `ClosePseudoConsole` runs on its own thread
because it can block until the output pipe drains.

Protocol-visible behaviour:

- `proc.kill` on a PTY process: `TERM`/`INT`/`HUP`/`QUIT` send that signal to the
  process group; the default (`KILL`) sends `SIGHUP` (like a closing terminal)
  and escalates to `SIGKILL` after 250 ms if the process is still alive.
- Exit of a signal-terminated PTY child is reported as `{code: 1, signal: "SIG<n>"}`
  (numeric, e.g. `SIG1` for SIGHUP), consistent with non-PTY processes (`proc.rs`).

### Why not `portable-pty`

It was evaluated again (an adapter over `portable-pty` 0.9 behind the same
interface) and rejected:

- **Windows job objects**: it starts the child immediately (no `CREATE_SUSPENDED`),
  so the job can only be assigned after the child already runs; processes it
  starts in that window escape the kill-on-close job.
- **Windows robustness**: ConPTY is resolved in a `lazy_static` with `.expect()`;
  where it is missing the panic is, in the immediate-abort build, a silent abort
  of the whole server instead of a failed `proc.spawn`. It also prefers a
  `conpty.dll` found on the DLL search path over the system one, and closes the
  pseudo console synchronously in `Drop` (blocking the runtime thread on older
  builds).
- **Unix `fork`/`exec` safety**: its `pre_exec` calls `close_random_fds()`, which
  reads `/dev/fd` and allocates between `fork` and `exec` — not async-signal-safe
  in our multi-threaded process (blocking pool, reader threads; musl's allocator
  lock can deadlock the child).
- **Kill semantics**: its killers send `SIGHUP` to the child pid only (no process
  group, no `TERM`/`INT`/`QUIT`), and the SIGHUP→SIGKILL escalation lives in a
  blocking `Child::kill` that sleeps; the adapter had to re-implement the
  process-group signalling with libc anyway. Exit signals come back as
  `strsignal` text ("Hangup"), not the protocol's `SIG<n>`.
- **Size**: it brings `winapi`, `shared_library`, `lazy_static`, `nix`, `serial2`,
  `filedescriptor`, `downcast-rs`, `shell-words`, and turns on `anyhow`'s `std`
  feature (backtrace capture). Nightly dist with the adapter: linux x64
  1880 KiB (+116 KiB, brotli +43 KiB), win x64 1992 KiB (+54 KiB, brotli
  +23 KiB) — while still missing the behaviour above.

## Testing

```sh
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo clippy --all-targets --target x86_64-unknown-linux-musl -- -D warnings
cargo clippy --all-targets --target aarch64-apple-darwin -- -D warnings
cargo test
# end-to-end (from repo root), against any built binary:
cd packages/plugin
DSH_ENV_SERVER_BIN=../../crates/dsh-env-server/target/<triple>/dist/dsh-env-server node --test test/env-server.test.ts
```
