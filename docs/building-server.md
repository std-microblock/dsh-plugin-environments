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

`[profile.release]` already uses `opt-level = "z"`, fat LTO, one codegen unit,
`panic = "abort"` and `strip = true`.

## Nightly `dist` build (recommended for CI, ~35–45 % smaller)

```sh
cargo +nightly dist --target <triple>
# -> target/<triple>/dist/dsh-env-server[.exe]
```

`dist` is a cargo alias (`.cargo/config.toml`) for:

```sh
cargo +nightly build --profile dist --target <triple> \
  -Zbuild-std=std,panic_abort \
  -Zbuild-std-features=optimize_for_size \
  --config "build.rustflags=['-Zunstable-options','-Cpanic=immediate-abort']"
```

- `-Zbuild-std` rebuilds std with the release profile (opt-level z, LTO across std).
- `optimize_for_size` selects smaller std algorithms (sorting, formatting
  helpers); behaviour is identical. Worth ~20 KiB on top of the rest.
- `-Cpanic=immediate-abort` (the current spelling; it replaced the old
  `-Zbuild-std-features=panic_immediate_abort`) removes the panic message /
  formatting / backtrace machinery. A panic now aborts immediately **without
  printing a message**. The server is written not to panic in normal operation;
  errors are reported through the protocol.
- Do not set `RUSTFLAGS` in the environment for this build: it overrides
  `build.rustflags` and silently drops `immediate-abort`.
- `-Zlocation-detail=none` was tried and gave no further reduction (0 bytes) once
  immediate-abort is on, so it is not used.
- `profile.dist` inherits `release` unchanged; it only exists so dist artifacts
  land in a separate directory.

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

Measured 2026-10-07, rustc 1.98.1 stable / 1.101.0-nightly (2026-10-05).
"before" = binaries shipped in `bin/` prior to the slimming work (no i686 build
existed). Compression: brotli quality 11, window 24 (node `zlib`); xz = LZMA2
preset 9 via 7-Zip (`xz -9e` was not available on the build host); gzip -9.

| target      | build          |         raw |   brotli-11 |    xz -9 |  gzip -9 |
| ----------- | -------------- | ----------: | ----------: | -------: | -------: |
| win x64     | before         |    5517 KiB |    1501 KiB | 1479 KiB | 2159 KiB |
| win x64     | stable release |     792 KiB |     322 KiB |  317 KiB |  390 KiB |
| win x64     | nightly dist   | **523 KiB** | **227 KiB** |  223 KiB |  271 KiB |
| linux x64   | before         |    7219 KiB |    1707 KiB | 1685 KiB | 2398 KiB |
| linux x64   | stable release |    1077 KiB |     428 KiB |  421 KiB |  526 KiB |
| linux x64   | nightly dist   | **608 KiB** | **253 KiB** |  248 KiB |  305 KiB |
| linux i686  | stable release |    1039 KiB |     445 KiB |  439 KiB |  539 KiB |
| linux i686  | nightly dist   | **587 KiB** | **259 KiB** |  256 KiB |  311 KiB |
| linux arm64 | before         |    7030 KiB |    1640 KiB | 1549 KiB | 2381 KiB |
| linux arm64 | stable release |     944 KiB |     399 KiB |  376 KiB |  515 KiB |
| linux arm64 | nightly dist   | **544 KiB** | **242 KiB** |  228 KiB |  311 KiB |

macOS arm64 is only type-checked from Windows (`cargo check --target
aarch64-apple-darwin`, stable and nightly build-std); linking needs the Apple
SDK, so build it on a macOS runner.

The network transports (secure channel, WebSocket, `connect`, lifeline) added
on top of the numbers above (nightly dist, measured 2026-10-07):

| target      |  before |   after | brotli-11 before → after |
| ----------- | ------: | ------: | -----------------------: |
| linux x64   | 608 KiB | 697 KiB |        253 KiB → 290 KiB |
| win x64     | 523 KiB | 601 KiB |        226 KiB → 261 KiB |
| linux arm64 | 544 KiB | 604 KiB |        242 KiB → 270 KiB |

Of that, the RustCrypto crates are ~25 KiB of `.text`; the rest is the
transport code and the extra tokio pieces it uses. `--cfg chacha20_force_soft
--cfg poly1305_force_soft` (dropping the SIMD backends) would save only ~13 KiB
and is not used.

## Why it is small (keep it that way)

Dependencies are deliberately minimal: `tokio` (current-thread runtime, trimmed
features), `serde_json` (no default features), `regex-lite`, `miniz_oxide`
(PNG/zlib encoding for screenshots), `getrandom`, the RustCrypto
`chacha20poly1305` / `hkdf` / `hmac` / `sha2` / `sha1` (secure channel and the
WebSocket handshake), plus `libc` / `windows-sys`. WebSocket framing and the
secure channel are in-tree (`src/ws.rs`, `src/secure.rs`); there is no TLS
(`rustls`/`tungstenite` would cost several hundred KiB).
The following were replaced by small in-tree code:

| removed crate(s)              | replacement                                                                                    |
| ----------------------------- | ---------------------------------------------------------------------------------------------- |
| `clap`                        | `src/cli.rs` hand-written argument parser and help text                                        |
| `portable-pty`                | `src/pty.rs` (openpty on Unix, ConPTY on Windows)                                              |
| `ignore`, `globset`, `grep-*` | `src/walk.rs` (gitignore-aware walker, glob matcher) + `src/search.rs` (regex-lite based grep) |
| `base64`, `png`               | `src/util.rs` (base64 codec, minimal PNG writer over `miniz_oxide`)                            |
| `rand`, `anyhow`              | `getrandom`, plain `io::Error` / `String` errors                                               |

Before adding a dependency, check the size impact of a stable release build for
at least one Linux target (`cargo bloat` or simply the raw size) and justify it.

## PTY implementation notes

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
is assigned to a job object before it runs (`kill` terminates the whole tree). Resize is `ResizePseudoConsole`.

Behaviour differences vs. the previous `portable-pty` version:

- `proc.kill` on a PTY process: `TERM`/`INT`/`HUP`/`QUIT` send that signal to the
  process group; the default (`KILL`) sends `SIGHUP` (like a closing terminal)
  and escalates to `SIGKILL` after 250 ms if the process is still alive.
- Exit of a signal-terminated PTY child is reported as `{code: 1, signal: "SIG<n>"}`
  (numeric, e.g. `SIG1` for SIGHUP), consistent with non-PTY processes
  (`proc.rs`), rather than a signal name.
- No other protocol-visible differences; see `docs/protocol.md`.

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
