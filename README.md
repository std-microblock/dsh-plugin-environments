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
- 输入框左下角的**环境**按钮：查看当前会话挂载在哪个环境上，在会话开始前为它挂载环境（或取消工作区默认环境的挂载），勾选本会话可借用的环境，或把勾选结果保存为该工作区的默认值。
- 侧边栏工作区列表：远程工作区的文件夹图标旁有一个链接图标；绑定了环境的工作区（远程工作区，或设置了默认环境的普通工作区）在行尾显示环境名称，环境不可用时（例如 adb 设备未连接、服务器连不上）显示红点，独占环境被占用时显示橙点。点击环境名称，或在工作区的“…”菜单里选择**环境设置…**，可以设置该工作区的默认环境和默认可借用列表。

## 环境类型

| 类型                   | 连接方式                                                                                                                                                                                                                                            | 能力                                                                                                                         |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 本机 `local`           | 把随插件附带的 `dsh-env-server` 作为 stdio 子进程启动                                                                                                                                                                                               | 全部能力：文件、进程/PTY、TCP/UDP 正反向隧道、glob/grep、截图、键鼠输入                                                      |
| 环境服务器 `server`    | 通过 TCP 连接到在目标机器上运行的 `dsh-env-server serve --listen 0.0.0.0:7461`，用令牌认证                                                                                                                                                          | 同上；截图和输入目前仅限 Windows 目标                                                                                        |
| SSH `ssh`              | 使用 ssh2 连接，支持密码、私钥或 ssh-agent。目标是 Linux x64/arm64 时，自动通过 SFTP 上传对应的静态 `dsh-env-server`（存放在 `~/.dsh-env/bin/`），再通过 exec 通道运行，从而获得完整能力。上传失败或目标是其他系统时，退回到 SFTP + exec + TCP 转发 | 完整能力，或退回后的基础能力                                                                                                 |
| Android `adb`          | 调用 adb CLI。`adb devices` 发现的设备会自动列出，可以一键加入列表                                                                                                                                                                                  | 文件（push/pull/exec-out）、shell（含 PTY）、TCP forward/reverse、截图、输入，以及 `install_apk`、`app`、`ui_dump`、`logcat` |
| Windows 账户 `winuser` | 创建一个本地标准账户（需要管理员确认），密码用 DPAPI 加密保存。连接时用 `CreateProcessWithLogonW` 以该账户身份在当前交互桌面上启动 `dsh-env-server`                                                                                                 | 全部能力。该账户启动的图形界面程序会显示在当前桌面，智能体可以截图并操作                                                     |

## 远程工作区（挂载）

在**环境**页面或环境卡片上选择“新建远程工作区”，在弹出的远程文件浏览器里选好目录。插件会在 `~/.dsh/env-mounts/` 下创建一个占位目录，并把它注册成普通工作区；在这个工作区里新建的会话（包括它的子智能体）都会自动挂载到该环境。挂载期间：

- 文件工具和 shell 工具在环境中执行。宿主机上的路径会映射到环境里的根目录，模型看到的工作目录就是环境里的真实路径。
- 环境里的 AGENTS.md / CLAUDE.md 会作为项目指令注入。
- 项目技能（`.agents/skills`、`.dsh/skills`）从环境中发现和读取。
- 只能在宿主机上运行的工具会被隐藏，包括 terminal、lsp、load_workspace_dependencies，以及与环境系统不匹配的那个 shell 工具。
- 挂载会占用该环境的一个租约，所以独占环境在挂载期间不能被别的会话借走。

也可以不建工作区，在普通会话开始前通过输入框里的“环境”按钮单独挂载。会话一旦开始，挂载就不能再更改。

## 工作区与环境的绑定

每个工作区最多绑定一个环境，决定其中的新会话挂载到哪里：

| 工作区                 | 绑定的环境                        | 说明                                                   |
| ---------------------- | --------------------------------- | ------------------------------------------------------ |
| 远程工作区             | 创建时选择的环境和目录，不能更改  | 侧边栏显示链接图标                                     |
| 设置了默认环境的工作区 | 工作区菜单“环境设置…”里选择的环境 | 可以指定环境里的目录，不指定时使用环境自身的默认目录   |
| 其他工作区             | 无                                | 会话在本机运行，可以在会话开始前通过“环境”按钮单独挂载 |

一个会话最终挂载到哪里，按以下顺序决定：

1. 会话自己的选择：在“环境”按钮里选了环境，或选了“不挂载”；
2. 远程工作区绑定的环境；
3. 工作区的默认环境，**只对尚未开始的会话生效**。会话开始挂载时，这个选择会记录到会话里，之后修改或清除工作区的默认环境，不会影响已经存在的会话；恢复旧会话时也不会把它挂到新的默认环境上。

默认环境只影响挂载，不影响借用。工作区的“默认可借用列表”（在同一个对话框里，或在“环境”按钮里点“设为此工作区默认”）仍然独立生效：会话自己的列表优先，其次是工作区的列表，都没有时可以借用全部环境。

侧边栏的状态点来自轻量检查，不会建立完整连接：本机始终可用；adb 设备看 `adb devices` 里是否在线；环境服务器和 SSH 尝试连接它的 TCP 端口；正在被会话使用的环境直接视为可用。结果缓存约 15 秒，侧边栏大约每 10 秒刷新一次。

## 借用

| 工具           | 作用                                                                                  |
| -------------- | ------------------------------------------------------------------------------------- |
| `env_list`     | 列出本会话可借用的环境、它们的状态，以及本会话已经借到的环境                          |
| `env_borrow`   | 借用一个环境；`wait: true` 时如果环境忙，会排队等待（可设超时）                       |
| `env_return`   | 归还环境，同时关闭通过它开启的进程和隧道                                              |
| `env_transfer` | 在本会话工作区和已借环境之间、或两个已借环境之间复制文件或目录，位置写成 `别名:/路径` |

借到之后的工具：`<别名>__exec`、`read_file`、`read_image`、`write_file`、`edit_file`、`list_dir`、`glob`、`grep`、`process_start` / `process_io` / `process_kill`（可交互的长时间进程）、`tunnel`（`to_env` / `from_env`，TCP 或 UDP）。

电脑操作（computer use）工具按环境能力出现：

| 工具          | 环境             | 作用                                                                                                                                                                       |
| ------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `screenshot`  | Windows、Android | 截图并缩小到长边 ≤ `max_size`（默认 1280），之后所有坐标都按这张图的像素计算；`region` 放大局部，`window` 截单个窗口，`display` 选显示器，可选 JPEG 和鼠标指针             |
| `input`       | Windows、Android | 按顺序执行动作：点击（双击、右键、修饰键）、移动、拖动、长按、滑动、滚动、输入 Unicode 文本、组合键、按住键、等待；`element: N` 直接指向 `ui` 列出的元素；可附带操作后截图 |
| `ui`          | Windows、Android | 列出界面元素（Android uiautomator / Windows UI Automation）：编号、类型、文字、id、中心坐标、大小、状态；可按文字查找并点击、设置文本、滚动、展开、切换等                  |
| `windows`     | Windows          | 列出顶层窗口，聚焦、最小化、最大化、还原、关闭、移动窗口                                                                                                                   |
| `device`      | Android          | 设备信息（型号、系统、屏幕尺寸/密度/方向、前台应用、输入法、亮屏/锁屏、电量），唤醒、熄屏、解锁（无密码时）、打开通知栏/快捷设置                                           |
| `app`         | Android          | 启动、停止、清除数据、卸载、查看信息、列出应用、当前前台 Activity、打开 URL、`am start` 任意 Intent                                                                        |
| `install_apk` | Android          | 从工作区或其他已借环境安装 APK                                                                                                                                             |
| `logcat`      | Android          | 读取最近的日志，可按文字和级别过滤                                                                                                                                         |

Android 上非 ASCII 文本需要设备装有 [ADB Keyboard](https://github.com/senzhk/ADBKeyBoard)（输入时临时切换，之后恢复原输入法），否则会明确报告不支持。

每个会话能借哪些环境：默认是全部环境；工作区设置了默认列表时继承它；会话也可以随时单独修改。独占环境（Android 和 Windows 账户默认独占）同一时间只能由一个会话持有，其他会话会按先后顺序排队。会话恢复时，插件会尝试重新借回上次持有的环境。

## 生命周期

- 每个连接、租约和隧道都绑定在 Cordis 的 fiber/scope 上，智能体销毁、归还或插件卸载时会自动清理。
- `dsh-env-server` 在连接断开时会结束它启动的所有进程树（Windows 用 Job Object，Unix 用进程组），并关闭监听和套接字。

## Windows 账户环境（`winuser`）

在**环境**页面创建账户后，插件会：

1. **创建**（需要管理员确认，装了 gsudo 时用 gsudo，否则弹出 UAC）：用 `NetUserAdd` 建一个注释为 `dsh-env managed` 的本地标准用户，随机密码用当前用户的 DPAPI 加密后存到插件数据目录的 `winusers/<账户>.secret`。可选地给若干目录授予该账户“修改”权限（`icacls /grant <账户>:(OI)(CI)M`，继承到已有的子文件）。
2. **连接**：把服务端二进制复制到 `%ProgramData%\dsh-env\dsh-env-server-<内容哈希>.exe`（插件自带的二进制通常在当前用户的配置目录里，其他账户进不去；`ProgramData` 下的文件继承 “Users：读取和执行”）。然后以当前用户身份运行 `dsh-env-server winuser launch --supervise`，它用 `CreateProcessWithLogonW(LOGON_WITH_PROFILE)` 以该账户身份启动 `serve --listen 127.0.0.1:<随机端口> --token <随机令牌> --once --cwd ~`：
   - 首次登录时 Windows 会创建账户的配置文件（`C:\Users\<账户>`，如果同名目录已存在则是 `C:\Users\<账户>.<计算机名>`）；`USERPROFILE`、`APPDATA`、`TEMP`、HKCU 都是该账户自己的。
   - 默认工作目录是该账户的主目录；环境配置里的 `cwd` 必须是该账户能进入的目录（例如授予过权限的工作区），否则启动会报“目录名称无效”。
   - 进程在当前交互会话的 `WinSta0\Default` 桌面上运行（不指定桌面时由 Secondary Logon 服务授予访问权限），所以它启动的窗口程序会显示在当前桌面上，截图和键鼠输入作用于同一块屏幕（坐标是物理像素）。服务端自己没有控制台窗口。
   - 服务端被放进由启动器持有的 Job Object（`KILL_ON_JOB_CLOSE`）。启动器作为插件的子进程一直运行，环境关闭、连接断开或 dsh 退出（启动器的 stdin 关闭）时，以该账户身份启动的整棵进程树都会被结束。
3. **删除**（需要管理员确认）：结束该账户的所有进程，删除账户，再用 `DeleteProfileW` 删除它的配置文件（配置文件卸载需要一点时间，会重试约 15 秒；删不掉时账户仍会删除，并返回警告）。

限制：

- 该账户是标准用户，环境里的程序不能提权：直接启动要求管理员权限的程序会失败（错误 740 “请求的操作需要提升”）；通过 ShellExecute 提权（例如 `Start-Process -Verb RunAs`）会在当前桌面弹出索要管理员凭据的 UAC 窗口，需要坐在电脑前的人处理。
- 同一时间只有一个交互桌面，该账户的窗口和当前用户的窗口在同一个桌面上，互相可见、可操作；锁屏时截图和输入可能失败。
- 端口只监听 `127.0.0.1`，但同一台机器上的其他本地用户也能连接这个端口，靠随机令牌认证；令牌出现在服务端的命令行里（只有该账户本身和管理员能读到）。
- 账户能读取所有对 “Users” 开放的位置（例如 `C:\Users\Public`、大多数程序目录），不能读写当前用户的配置目录，除非显式授权。
- 依赖 Secondary Logon 服务（`seclogon`）；禁用该服务或组策略禁止该账户“本地登录”时会给出对应的错误说明。
- 密码只能由创建账户的那个 Windows 用户解密（DPAPI）；换了用户或数据目录丢失后需要删除并重建账户。

## Windows 输出编码

中文 Windows 的控制台默认代码页是 936（GBK），`cmd`、`ping`、`net`、Windows PowerShell 等写进管道的文字原本会被当成 UTF-8 解码成乱码。现在：

- `proc.spawn` 默认（`encoding: 'utf8'`）让子进程运行在 UTF-8 控制台上（服务端通过 `dsh-env-server __utf8-console` 包装一层，调用 `SetConsoleCP/SetConsoleOutputCP(65001)`），`command` 模式还会把 Windows PowerShell 的 `$OutputEncoding` 设为 UTF-8；仍不是 UTF-8 的输出行按 OEM 代码页转码。这样 GBK 以外的字符（emoji、韩文等）也不会变成 `?`。副作用：在 UTF-8 控制台上，`ping`、`net`、Windows PowerShell 等系统工具会输出英文提示。
- `encoding: 'auto'` 保持控制台原来的代码页（提示保持中文），只把非 UTF-8 的输出行按 OEM 代码页转成 UTF-8；`encoding: 'raw'` 原样转发字节（二进制输出）。
- PTY（ConPTY）本身就输出 UTF-8，不做任何转换。
- 插件在宿主机上运行的程序（adb、提权助手）的输出同样按“UTF-8 优先，否则 OEM 代码页”解码；进程输出按流解码，多字节字符跨数据块时不会被截断。

详见 [docs/protocol.md](docs/protocol.md) 的 `proc.spawn` 一节。

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
pnpm test                      # 协议单元测试 + 插件集成测试：env-server、ssh、adb（模拟设备）、租约、挂载映射
pnpm build:server              # cargo 构建 crates/dsh-env-server，并放到 packages/plugin/bin/
pnpm build:plugin              # packages/plugin/dist/index.js
pnpm build:client              # packages/plugin/client.js
```

`crates/dsh-env-server` 是 Rust 写的 `dsh-env-server`，子命令有 `serve`、`stdio`、`winuser create|delete|list|launch|grant`。Linux 静态二进制通过 `rust-lld` 交叉编译，不需要额外的工具链。

## 已知限制

- 截图和键鼠输入在 Linux/macOS 的 `dsh-env-server` 上暂不支持。Android 的截图和输入走 adb。
- 走纯 SSH（未运行 `dsh-env-server`）时只有 TCP 隧道；远端是 Windows 时也不支持 grep。
- 挂载会话中，GUI 侧栏的文件树、diff 摘要和 `@` 文件补全仍然显示宿主机上的占位目录。
- DSH 没有为工作区行和工作区菜单提供插件扩展位，侧边栏里的链接图标、环境名称和“环境设置…”菜单项是按工作区行的 `data-row-key` 属性插入到页面里的。DSH 改变侧边栏结构后，这些装饰可能不再显示，但不会影响其他功能。
- 同一台 Windows 机器上同一时间只有一个交互桌面，Windows 账户环境的程序和当前用户共用这个桌面（其他限制见上面的“Windows 账户环境”）。
- Windows 上默认的 UTF-8 模式下，`proc.spawn` 返回的 `pid` 是 `__utf8-console` 包装进程的 pid。
