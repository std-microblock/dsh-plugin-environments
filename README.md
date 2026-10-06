# dsh-plugin-environments

给 DeepSeek Harness（dsh）的环境管理插件。它让智能体可以使用别的设备，例如本机、自己部署的服务器、SSH 主机、Android 真机或模拟器，以及本机上的 Windows 受限测试账户。每个环境有两种用法：

- **挂载**：在创建会话时由人选择。会话里内置的 `read` / `write` / `edit` / `read_image` / `glob` / `grep` / `bash`（Windows 环境为 `pwsh`）会直接在环境中执行，AGENTS.md 和项目技能也从环境中读取。
- **借用**：智能体在需要时调用 `env_borrow`，借到后获得一组以环境别名为前缀的工具（例如 `pixel__screenshot`、`pixel__install_apk`），用完调用 `env_return` 归还，这些工具随即消失。

## 安装

```sh
pnpm install
pnpm run build        # 构建 dsh-env-server（本机 + Linux x64/arm64）、插件 dist/ 和 client.js
dsh plugin --profile desktop add link:G:/dsh-plugin-remote-environments/packages/plugin
```

插件包位于 `packages/plugin`（包名仍是 `dsh-plugin-environments`）。`pnpm run build` 会把服务端二进制放到 `packages/plugin/bin/<platform>-<arch>/`，把插件打包到 `packages/plugin/dist/index.js`，把界面打包到 `packages/plugin/client.js`；这些都是构建产物，不进入 git。

安装后会出现以下入口：

- 侧边栏的**环境**页面：管理环境、测试连接、浏览远程文件、新建远程工作区、查看和释放正在使用的环境。
- 输入框左下角的**环境**按钮：查看当前会话挂载在哪个环境上，在会话开始前为它挂载环境，勾选本会话可借用的环境，或把勾选结果保存为该工作区的默认值。

## 环境类型

| 类型                   | 连接方式                                                                                                                                                                                                                                                                                                                                                | 能力                                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 本机 `local`           | 把随插件附带的 `dsh-env-server` 作为 stdio 子进程启动                                                                                                                                                                                                                                                                                                   | 全部能力：文件、进程/PTY、TCP/UDP 正反向隧道、glob/grep、截图、键鼠输入                                                      |
| 环境服务器 `server`    | 连接到目标机器上运行的 `dsh-env-server serve`，地址可以是 `host:port`、`tcp://`、`ws://`，或经 TLS 反向代理的 `wss://`。用共享密钥做双向认证并加密（见下文“网络连接”）                                                                                                                                                                                  | 同上；截图和输入目前仅限 Windows 目标                                                                                        |
| SSH `ssh`              | 使用 ssh2 连接，支持密码、私钥或 ssh-agent。自动识别远端系统和架构（Linux x64/ia32/arm64、macOS arm64、Windows x64 OpenSSH），按内容哈希只上传一次对应的 `dsh-env-server`（`~/.dsh-env/bin/`，目录权限 0700）；连接时才启动、断开即退出，数据走 SSH 端口转发。SSH 服务端禁止转发时退回 exec 通道的 stdio；没有合适的二进制时退回 SFTP + exec + TCP 转发 | 完整能力，或退回后的基础能力                                                                                                 |
| 反向连接 `reverse`     | 目标机器运行 `dsh-env-server connect` 主动连到插件开启的 TCP / WebSocket 监听，适合目标机器没有公网地址的情况；断线后自动重连                                                                                                                                                                                                                           | 与环境服务器相同                                                                                                             |
| Android `adb`          | 调用 adb CLI。`adb devices` 发现的设备会自动列出，可以一键加入列表                                                                                                                                                                                                                                                                                      | 文件（push/pull/exec-out）、shell（含 PTY）、TCP forward/reverse、截图、输入，以及 `install_apk`、`app`、`ui_dump`、`logcat` |
| Windows 账户 `winuser` | 创建一个本地标准账户（需要管理员确认），密码用 DPAPI 加密保存。连接时用 `CreateProcessWithLogonW` 以该账户身份在当前交互桌面上启动 `dsh-env-server`                                                                                                                                                                                                     | 全部能力。该账户启动的图形界面程序会显示在当前桌面，智能体可以截图并操作                                                     |

## 网络连接

`server` 和 `reverse` 两种环境的连接可能经过公网，所以总是先建立一层安全通道：双方用每个环境独立的高熵共享密钥互相认证，再派生出两个方向各自的 ChaCha20-Poly1305 密钥加密全部流量。密钥本身从不在网络上传输，也不需要证书。细节见 [docs/protocol.md](docs/protocol.md#secure-channel)。

| 谁有公网地址 | 做法                                                                                                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 目标机器     | 在目标机器上运行 `dsh-env-server serve --listen 0.0.0.0:7461 --token-file token.txt`（或 `--listen ws://0.0.0.0:7461/dsh-env`），然后添加“环境服务器”，填入地址和 token.txt 里的密钥 |
| dsh 这台电脑 | 添加“反向连接”环境，在对话框里开启 TCP 和/或 WebSocket 监听。保存后会显示一次可以直接复制的命令（Linux/macOS 和 PowerShell 两种），在目标机器上运行即可                              |

- 密钥通过文件（`--token-file`）或标准输入（`--token-stdin`）交给 `dsh-env-server`。`--token` 会出现在其他用户可见的进程列表里，不建议使用。
- 需要 TLS 时，把 `ws://` 监听放在 nginx、Caddy 等反向代理之后，插件一侧直接填 `wss://` 地址；`dsh-env-server` 本身不带 TLS。
- 反向监听默认端口是 TCP 7462、WebSocket 7463（路径 `/dsh-env`），默认关闭。也可以在插件配置里用 `reverse: { tcp: { enabled, host, port }, ws: { enabled, host, port, path }, publicHost }` 预设；在界面里改过之后以界面为准。
- 重新生成密钥会立即断开该环境现有的反向连接。

## 远程工作区（挂载）

在**环境**页面或环境卡片上选择“新建远程工作区”，在弹出的远程文件浏览器里选好目录。插件会在 `~/.dsh/env-mounts/` 下创建一个占位目录，并把它注册成普通工作区；在这个工作区里新建的会话（包括它的子智能体）都会自动挂载到该环境。挂载期间：

- 文件工具和 shell 工具在环境中执行。宿主机上的路径会映射到环境里的根目录，模型看到的工作目录就是环境里的真实路径。
- 环境里的 AGENTS.md / CLAUDE.md 会作为项目指令注入。
- 项目技能（`.agents/skills`、`.dsh/skills`）从环境中发现和读取。
- 只能在宿主机上运行的工具会被隐藏，包括 terminal、lsp、load_workspace_dependencies，以及与环境系统不匹配的那个 shell 工具。
- 挂载会占用该环境的一个租约，所以独占环境在挂载期间不能被别的会话借走。

也可以不建工作区，在普通会话开始前通过输入框里的“环境”按钮单独挂载。会话一旦开始，挂载就不能再更改。

## 借用

| 工具           | 作用                                                                                  |
| -------------- | ------------------------------------------------------------------------------------- |
| `env_list`     | 列出本会话可借用的环境、它们的状态，以及本会话已经借到的环境                          |
| `env_borrow`   | 借用一个环境；`wait: true` 时如果环境忙，会排队等待（可设超时）                       |
| `env_return`   | 归还环境，同时关闭通过它开启的进程和隧道                                              |
| `env_transfer` | 在本会话工作区和已借环境之间、或两个已借环境之间复制文件或目录，位置写成 `别名:/路径` |

借到之后的工具：`<别名>__exec`、`read_file`、`read_image`、`write_file`、`edit_file`、`list_dir`、`glob`、`grep`、`process_start` / `process_io` / `process_kill`（可交互的长时间进程）、`tunnel`（`to_env` / `from_env`，TCP 或 UDP）。环境支持时还有 `screenshot` 和 `input`；Android 环境另外有 `install_apk`、`app`、`ui_dump`、`logcat`。

每个会话能借哪些环境：默认是全部环境；工作区设置了默认列表时继承它；会话也可以随时单独修改。独占环境（Android 和 Windows 账户默认独占）同一时间只能由一个会话持有，其他会话会按先后顺序排队。会话恢复时，插件会尝试重新借回上次持有的环境。

## 生命周期

- 每个连接、租约和隧道都绑定在 Cordis 的 fiber/scope 上，智能体销毁、归还或插件卸载时会自动清理。
- `dsh-env-server` 在连接断开时会结束它启动的所有进程树（Windows 用 Job Object，Unix 用进程组），并关闭监听和套接字。
- SSH 环境的服务端只在连接期间存在：它以 `--lifeline --exit-idle` 启动，SSH 通道关闭（主动断开、插件卸载或网络中断）或它唯一的会话结束时立即退出，不会留下孤儿进程。每次启动都使用新的随机密钥，经标准输入传入。

## 协议

文档见 [docs/protocol.md](docs/protocol.md)：

- 帧格式：长度前缀，JSON 头加二进制负载。
- 请求和响应可以并发、可以取消。
- 通道带 1 MiB 的信用窗口做流控，用于进程标准输入输出、文件流和网络隧道。
- 有心跳机制。

## 开发

这是一个 TypeScript（strict）pnpm monorepo，目录结构和约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。

```sh
pnpm install
pnpm lint && pnpm typecheck    # ESLint（type-aware）+ tsc
pnpm test                      # 协议单元测试（安全通道、WebSocket）+ 插件集成测试：env-server、ssh、反向连接、adb（模拟设备）、租约、挂载映射
pnpm build:server              # cargo 构建 crates/dsh-env-server，并放到 packages/plugin/bin/
pnpm build:plugin              # packages/plugin/dist/index.js
pnpm build:client              # packages/plugin/client.js
```

`crates/dsh-env-server` 是 Rust 写的 `dsh-env-server`，子命令有 `serve`、`connect`、`stdio`、`winuser create|delete|list|launch|grant`。WebSocket 和安全通道是手写的小实现，加密只依赖 RustCrypto 的 `chacha20poly1305`、`hkdf`、`hmac`、`sha2` / `sha1`。Linux 静态二进制通过 `rust-lld` 交叉编译，不需要额外的工具链。

## 已知限制

- 截图和键鼠输入在 Linux/macOS 的 `dsh-env-server` 上暂不支持。Android 的截图和输入走 adb。
- 走纯 SSH（未运行 `dsh-env-server`）时只有 TCP 隧道；远端是 Windows 时也不支持 grep。
- 挂载会话中，GUI 侧栏的文件树、diff 摘要和 `@` 文件补全仍然显示宿主机上的占位目录。
- 同一台 Windows 机器上同一时间只有一个交互桌面，Windows 账户环境的程序和当前用户共用这个桌面。
- 安全通道只基于共享密钥，没有前向保密：密钥泄露后，录下的旧流量可以被解密。发现泄露请在界面里重新生成密钥（反向连接）或更换 token 文件（环境服务器）。
