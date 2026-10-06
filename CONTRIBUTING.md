# Contributing

## Layout

```
package.json              private workspace root (scripts only)
pnpm-workspace.yaml       packages/*
tsconfig.base.json        shared strict compiler options (noEmit; type stripping friendly)
eslint.config.js          typescript-eslint, type-aware
scripts/                  build scripts in TypeScript, run directly by Node (type stripping)
  build.ts                entry: --server / --plugin / --client (no flag = all)
  build-plugin.ts         esbuild → packages/plugin/dist/index.js
  build-client.ts         esbuild → packages/plugin/client.js (DSH lazy-CJS module wrapper)
  build-server.ts         cargo builds per target (stable or pinned-nightly dist), staged into bin/
  server-targets.ts       the five shipped targets (package dir ↔ Rust triple)
  dist-toolchain.txt      the pinned nightly for `cargo dist` (the only place it is set)
  package.ts              release package: out/<name>-<version>.tgz, per-target .gz binaries, SHA256SUMS
  release-version.ts      set / check the version in every manifest
packages/
  protocol/               @dsh-environments/protocol (private): framing, message types, typed op map, EnvClient
  plugin/                 dsh-plugin-environments (published): the host plugin
    src/
      index.ts            plugin entry (name / inject / apply)
      deps.ts             lazily loaded DSH runtime modules
      host-api.ts         local declarations of the DSH host surface the plugin uses
      env/                Environment abstraction and implementations
        environment.ts    abstract base class: capabilities, tunnels, exec()
        types.ts          shared option/result/process types
        server/           dsh-env-server backed environments (stdio child, TCP/WebSocket + secure channel, reverse hub, tunnels)
        ssh/              SSH: connection, server provisioning, plain SFTP/exec fallback
        adb/              Android over the adb CLI
        winuser/          dsh-managed Windows accounts
        host-env.ts       the harness host filesystem (transfer endpoint)
      manager/            definitions, persisted state, leases and queueing
      mount/              routing a session's own fs/shell tools into an environment
      borrowing/          env_list / env_borrow / env_return / env_transfer
      tools/              model-facing tool helpers and the per-lease tool sets
      api/                HTTP API for the GUI
    test/                 node:test suites (*.test.ts), fixtures, manual/ scripts for real devices
  client/                 @dsh-environments/client (private): React GUI
crates/dsh-env-server/    Rust server (built by `pnpm build:server`)
docs/                     protocol, server build and research notes
.github/workflows/        build.yml (reusable: checks, binaries, tests, package), ci.yml, release.yml
```

`packages/plugin/{dist,bin,client.js}` and `out/` are build outputs and are not committed.

## Commands

| Command                        | What it does                                                                                                         |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `pnpm install`                 | install the workspace                                                                                                |
| `pnpm lint`                    | ESLint over every package and script                                                                                 |
| `pnpm typecheck`               | `tsc` for scripts and every package                                                                                  |
| `pnpm test`                    | node:test suites of every package                                                                                    |
| `pnpm format`                  | Prettier (`format:check` in CI)                                                                                      |
| `pnpm build`                   | server + plugin + client                                                                                             |
| `pnpm build:server`            | cargo build, binaries staged in `packages/plugin/bin/<platform>-<arch>/`                                             |
| `pnpm build:plugin`            | `packages/plugin/dist/index.js`                                                                                      |
| `pnpm build:client`            | `packages/plugin/client.js`                                                                                          |
| `pnpm build:server:dist`       | smaller pinned-nightly server build (flags of `scripts/build-server.ts`: `--target`, `--all`, `--fallback`, `--out`) |
| `pnpm run package`             | release package in `out/` (`--allow-missing` locally, e.g. without a macOS binary; `--no-build`, `--bin-dir`)        |
| `pnpm release:version <x.y.z>` | set the version everywhere (`--check [x.y.z]` verifies)                                                              |

Tests that need a `dsh-env-server` binary skip themselves when none is found (see
`serverBinary()` in `packages/plugin/src/env/server/connect.ts`; `DSH_ENV_SERVER_BIN` overrides the host binary,
`DSH_ENV_SERVER_BIN_DIR` replaces the `bin/` directory for all targets). CI sets `DSH_ENV_SERVER_REQUIRED=1` so they fail
instead of skipping.

Install the plugin from the checkout with
`dsh plugin --profile desktop add link:G:/dsh-plugin-remote-environments/packages/plugin`.

## Conventions

- Strict TypeScript with `noUncheckedIndexedAccess` and `erasableSyntaxOnly`: no enums, namespaces or
  parameter properties, so sources run directly under Node's type stripping (tests, scripts).
- Relative imports carry the `.ts` extension. Workspace packages export their TypeScript sources and
  are bundled into the plugin; `ssh2` and `@deepseek-ai/*` stay external.
- DSH runtime modules are imported lazily inside `apply` (`deps.ts`) so the bundle loads without them.
  Their published typings are used where self-contained (`FileSystem`, `SubprocessRuntime`,
  `defineTool`); everything else the plugin touches is declared in `host-api.ts`.
- Avoid `any`; prefer `unknown` plus narrowing (`errorCode` / `errorMessage` from the protocol package).

## Adding things

- **A protocol op**: add it to `OpMap` in `packages/protocol/src/types.ts`; `client.call(op, args)` is then
  type-checked. Document it in `docs/protocol.md`.
- **An environment kind**: subclass `Environment` (override only what it supports and report
  `info.caps`), add an opener in `EnvironmentManager.open`, the kind to `KINDS` and its config fields to
  `EnvironmentConfig` in `manager/definitions.ts`, and an icon/form in the client.
- **A borrowed-environment tool**: add it in the matching `tools/lease/*-tools.ts` (gate it on a
  capability with `env.hasCap(...)`).

## CI

`.github/workflows/build.yml` is a reusable workflow; `ci.yml` runs it on every push to `master` and every PR,
`release.yml` on tags. Jobs:

- **Rust check** (ubuntu, windows, macOS): `cargo fmt --check` (ubuntu), `cargo clippy --all-targets -D warnings`
  (plus the musl target on ubuntu), `cargo test` (ubuntu, windows).
- **Server `<target>`**: one job per shipped target on its native runner family (MSVC on Windows, the three
  musl targets via rust-lld on ubuntu, `aarch64-apple-darwin` on macOS), built with
  `node scripts/build-server.ts --dist` and the nightly pinned in `scripts/dist-toolchain.txt`. CI falls back to
  the stable `--release` build with a warning if that nightly breaks; releases do not. Artifacts: `server-<target>`.
- **Node** (ubuntu, windows): format/lint/typecheck (ubuntu), then `pnpm test` with the freshly built host binary
  staged in `packages/plugin/bin/`, so the env-server integration tests always run.
- **Server on ia32 / arm64**: `--version` smoke tests and the env-server suite against the linux-ia32 binary
  (native) and the linux-arm64 binary under qemu-user (informational).
- **Package**: `pnpm run package` with all five binaries; artifact `package` is exactly what a release would publish.

To bump the pinned nightly, edit `scripts/dist-toolchain.txt`, run `pnpm build:server:dist` locally for a Linux
target and update the size table in `docs/building-server.md`.

## Releasing

1. `pnpm release:version 1.2.3` — updates every `package.json`, `crates/dsh-env-server/Cargo.toml` and its
   `Cargo.lock` entry, and `CLIENT_ID` in `packages/protocol/src/types.ts`.
2. Optionally check the package locally:
   `pnpm build:server:dist --target win32-x64,linux-x64,linux-ia32,linux-arm64` then
   `pnpm run package --allow-missing` (darwin-arm64 only links on macOS). Output in `out/`.
3. Commit (`chore: release v1.2.3`), then `git tag v1.2.3` and push the commit and the tag.

The tag runs `release.yml`:

- `verify`: the tag must equal every recorded version (`pnpm release:version --check v1.2.3`).
- `build`: the whole CI build in strict mode (no stable fallback; all five targets required).
- `publish` (the only job with `contents: write`):
  - commits the unpacked package to the `release` branch — one commit per version on top of the previous one,
    tree = exactly the package contents — and tags it `release-v1.2.3`;
  - creates the GitHub release `v1.2.3` with `dsh-plugin-environments-1.2.3.tgz`,
    `dsh-env-server-1.2.3-<target>[.exe].gz`, `SHA256SUMS` and generated notes.

Tags with a pre-release suffix (`v1.2.3-rc.1`) create a pre-release and the `release-v1.2.3-rc.1` tag but leave
the `release` branch on the last stable version.

Users install with any of:

```sh
dsh plugin add https://github.com/std-microblock/dsh-plugin-environments/releases/download/v1.2.3/dsh-plugin-environments-1.2.3.tgz
dsh plugin add github:std-microblock/dsh-plugin-environments#release
dsh plugin add github:std-microblock/dsh-plugin-environments#release-v1.2.3
```

The published `package.json` is `packages/plugin/package.json` without `private`, `scripts` and
`devDependencies` (workspace packages are bundled into `dist/index.js`); `scripts/package.ts` refuses to package
`workspace:`/`link:`/`file:` specs and checks the tarball contents and the Brotli round trip of every binary.
