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
        server/           dsh-env-server backed environments (stdio child, TCP, tunnels)
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
docs/                     protocol and research notes
```

`packages/plugin/{dist,bin,client.js}` are build outputs and are not committed.

## Commands

| Command             | What it does                                                             |
| ------------------- | ------------------------------------------------------------------------ |
| `pnpm install`      | install the workspace                                                    |
| `pnpm lint`         | ESLint over every package and script                                     |
| `pnpm typecheck`    | `tsc` for scripts and every package                                      |
| `pnpm test`         | node:test suites of every package                                        |
| `pnpm format`       | Prettier (`format:check` in CI)                                          |
| `pnpm build`        | server + plugin + client                                                 |
| `pnpm build:server` | cargo build, binaries staged in `packages/plugin/bin/<platform>-<arch>/` |
| `pnpm build:plugin` | `packages/plugin/dist/index.js`                                          |
| `pnpm build:client` | `packages/plugin/client.js`                                              |

Tests that need a `dsh-env-server` binary skip themselves when none is found (see
`serverBinary()` in `packages/plugin/src/env/server/connect.ts`; `DSH_ENV_SERVER_BIN` overrides).

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
