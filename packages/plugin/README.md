# dsh-plugin-environments

Environments for the DeepSeek Harness (dsh): mount or borrow the local machine, a `dsh-env-server`
host, SSH hosts, Android devices (adb) and dsh-managed Windows accounts.

```sh
# a released version (GitHub release asset)
dsh plugin add https://github.com/std-microblock/dsh-plugin-environments/releases/download/vX.Y.Z/dsh-plugin-environments-X.Y.Z.tgz
# the latest release (or pin one with #release-vX.Y.Z)
dsh plugin add github:std-microblock/dsh-plugin-environments#release
# a source checkout (after pnpm build)
dsh plugin --profile desktop add link:<checkout>/packages/plugin
```

This package is built from the monorepo at <https://github.com/std-microblock/dsh-plugin-environments>:
`dist/` (host plugin), `client.js` (web GUI) and `bin/<platform>-<arch>/dsh-env-server[.exe]` are build
outputs (`pnpm build`). Release packages ship the server for win32-x64, linux-x64, linux-ia32, linux-arm64
and darwin-arm64 as Brotli-compressed `dsh-env-server[.exe].br`, unpacked into `~/.dsh/cache/` on first use.
See the repository README for features and usage, and `docs/protocol.md` for the server protocol.
