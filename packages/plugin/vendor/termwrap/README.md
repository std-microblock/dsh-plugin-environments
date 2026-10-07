# TermWrap payload

This directory is where the **TermWrap** binaries are staged when a release bundles them. In a
plain source checkout it only holds this README: without a payload the plugin never offers the
one-click install and `session.status` reports `termwrap.present === false`.

## What it is

[TermWrap](https://github.com/llccd/TermWrap) is a rewrite of RDP Wrapper, **MIT licensed
(© 2022 llccd and the other contributors)**. It takes over the Terminal Services service DLL,
patches the loaded image _in memory_ so a client SKU can host the Remote Desktop host and several
simultaneous sessions, and finds its own patch offsets at run time (no per-build table to keep in
sync).

Staged payload (TermWrap 0.6, x64):

| File                                                        | Why                                                                                                 |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `TermWrap.dll`                                              | the wrapper for `TermService`                                                                       |
| `UmWrap.dll`                                                | the wrapper for `UmRdpService` (needed on Home/Server SKUs)                                         |
| `Zydis.dll`                                                 | disassembler TermWrap uses to search for its patch offsets                                          |
| `Install_termwrap_umwrap.reg` / `Install_termwrap_only.reg` | upstream's registry files; they point the two services at the DLLs in `%ProgramFiles%\RDP Wrapper\` |
| `Revert_to_default.reg` / `Revert_to_rdpwrap.reg`           | upstream's uninstall files, kept so a user can back out                                             |
| `LICENSE`                                                   | upstream MIT text (the release archive does not carry one)                                          |
| `VERSION`                                                   | staged version                                                                                      |

`EndpWrap.dll` (audio recording redirection) is deliberately **not** staged: upstream warns it
loads into every application that plays remote audio, can make some of them hang, and needs files
in `System32`.

## Staging it (build time - nothing is downloaded at install time)

```sh
# 1. on a networked build machine: download the TermWrap release you intend to ship and review it
# 2. stage it offline from the local file:
node scripts/stage-termwrap.ts --from <downloaded.zip|extracted-dir> --version <upstream-version>
# 3. see what is staged:
node scripts/stage-termwrap.ts
```

`--from` extracts the archive with `tar.exe` (no network access) and keeps the files above.
`pnpm run package` bundles this directory into the plugin tarball and fails if it went missing;
installing needs no network at all.

## Defender

Microsoft Defender has a first-party detection for this family (`HackTool:Win64/RDPWrap!MTB`), so
`dsh-env-server session install` adds `%ProgramFiles%\RDP Wrapper\` to the Defender exclusions
**before** copying anything (skippable with `--no-exclusion`, reversible with
`Remove-MpPreference -ExclusionPath`). See docs/session-mode.md.
