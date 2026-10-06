# dsh-plugin-environments

Environments for the DeepSeek Harness (dsh): mount or borrow the local machine, a `dsh-env-server`
host, SSH hosts, Android devices (adb) and dsh-managed Windows accounts.

```sh
dsh plugin --profile desktop add link:<checkout>/packages/plugin
```

This package is built from the monorepo at the repository root: `dist/` (host plugin), `client.js`
(web GUI) and `bin/<platform>-<arch>/dsh-env-server` are build outputs (`pnpm build`). See the
repository README for features and usage, and `docs/protocol.md` for the server protocol.
