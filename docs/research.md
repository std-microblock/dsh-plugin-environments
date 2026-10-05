# dsh 环境管理插件 — 方案调研

> 调研对象：`G:\deepseek-harness`（master @ f5912f47cc），以及外部的同类项目。
> 状态：调研稿，尚未写任何实现代码。文中「⚠ 待验证」的地方需要先写原型确认。

---

## 0. 结论速览

1. **DSH 已有「执行世界（execution world）」这个抽象，环境插件应该直接复用它，不要另起炉灶。**
   - `ctx.fs` 和 `ctx.subprocess` 合起来定义一个执行世界，`ctx.sandbox` 是同一世界内的约束。
   - 上层消费方都只依赖这几个 seam，包括 tool-fs（read / write / edit / read_image）、bash / pwsh、终端（PTY）、LSP 和 PTC。
   - 参见 `.agents/notes/implemented/architecture/2026-07-28-portable-execution-world-consumers.md`。
2. **仓库里已经有一个远端执行世界的实现：`packages/ssh/{ssh,fs-ssh,subprocess-ssh,sandbox-ssh}`**，它取代了早先被移除的 E2B 实现。但它不能直接拿来用：
   - 部署级生效：替换的是根 `ctx.fs` / `ctx.subprocess`，不能按 session 切换。
   - 两端都必须是 POSIX：客户端在 win32 上直接拒绝启动，**而你的宿主机正是 Windows**。
   - 远端 Node helper 需要手动预装。
   - 不重连。
   - 不提供用户可用的端口转发。
   - 它的 helper 协议（`ssh/ssh/src/{protocol,helper,helper-processes}.ts`）可以作为 environment-server 的参考。
3. **「借用」所需的机制都已具备，可以直接做：**
   - 通过 agent scope 注册的工具只对该 agent 可见，并会遮蔽同名的全局工具。
   - 每个 step 都会重新组装工具列表，所以增删工具从下一次模型请求起生效，并自动记入 `request/header`。
   - 最接近的模板是 `packages/experimental/browser-use-runtime`，它按 agent 用 `createScope` 挂载 MCP client，并用 `SessionResources` 管理独占资源。
4. **「挂载」可以做，但有三个硬骨头：**
   - (a) 按 agent 替换 service 要用 `createScope(ctx, agent).ctx.isolate('fs')…`。这种写法在生产代码里只有 preset 的 YAML 用过，没有程序化的先例，⚠ 需要先做原型验证。
   - (b) Session 的 cwd 和 Workspace 都**强制是宿主机上真实存在的目录**：创建时会 `mkdir`、`realpath`、`stat`，header 里的 cwd 也不可修改。
   - (c) 不少插件绕过了 seam，或者用的是根 `ctx.fs`。这包括 glob / grep（它们调用宿主机上 `rg` 的路径）、技能、AGENTS.md、`@` 文件引用、workspace-changes 的 diff，以及 GUI 的文件侧栏和终端。
5. **没有任何 ADB / Android 相关代码。** Windows 沙箱用的是「受限令牌 + ACL」，**不会创建本地账户，也不处理桌面会话**。所以受限账户和 GUI 支持完全是新领域。
6. 外部同类项目中，**最接近你的通用接口的是 [distant](https://github.com/chipsenkbeil/distant)**：它提供 fs、流式 proc、正反向 TCP tunnel、search 和 capability 标志。借用 / 排队模型可以参考 STF、Selenium Grid 和 labgrid。设备工具可以参考 [mobile-mcp](https://github.com/mobile-next/mobile-mcp)，它是唯一把 allocate / release 做成 agent 工具的项目。

---

## 1. DSH 里的相关基础设施

### 1.1 能力 seam（都是「每个 Cordis context 一个实现」）

| seam | 定义 | 关键能力 | 对环境插件的意义 |
|---|---|---|---|
| `ctx.fs` | `packages/fs/fs/src/index.ts` | `resolve`/`stat`/`lstat`/`readText`/`streamText`/`readBytes`/`readByteRange`/`listDir`/`writeText`/`editText`/`watch`/`processPath`/`fileUrl`/`contains` | **没有** 二进制写、mkdir、delete、rename、glob、grep。挂载时由 adapter 映射到环境接口。 |
| `ctx.subprocess` | `packages/subprocess/subprocess/src/{index,types}.ts` | `spawn`：stdin、stdout、stderr 和 fd7 control 都可以设成 `'pipe'`，支持 terminate 和 waitForExit；`spawnTerminal`：PTY，支持 resize、write 和前台进程组；`resolveExecutable`；`terminalEnvironment` | 「双工 spawn」在这里已经有成熟的契约，包括异步取消和受管清理。 |
| `ctx.shell` | `packages/shell/shell` | 位于 bash-local / pwsh-local 之上，内部调用 `ctx.subprocess` | 挂载时只要 subprocess 被替换，bash 和 pwsh 会自动跟随。注意 hooks（claude-code / codex）也走这里。 |
| `ctx.sandbox` / `ctx.sandboxPolicy` | `packages/sandbox/*` | `confine(argv, policy)`；`workspaceRoot = session.header.cwd` | 远端环境可以只支持 `danger-full-access`，也可以提供自己的 sandbox provider。 |
| `ctx.terminals` | `packages/terminal/terminal` | 后端按 type 注册，`spawn` 时会拿到 `owner: Agent` | 天然支持按 agent 路由。 |
| `ctx.tools` | `packages/core/tools` | `register()` 可以是全局或 scoped，scoped 遮蔽全局；`restrict()`；`tools/execute` 环绕事件，按 scope 过滤 | 「借用」时动态出现和消失的工具就靠它。 |
| `ctx.attachments` | `packages/attachment` | `saveImage` 返回 `ImageAttachmentRef` | screenshot 类工具把图片返回给模型时走这里。参照 `tool-fs/src/read-image.ts`。 |
| `ctx.storageDomain` | `packages/storage/storage-domain` | `defineDomain` + 表 | 用来保存环境定义和每个 workspace 的可借用列表。 |
| `ctx.sessionProjections` | `packages/session/session-projection` | 从事件流折叠出 per-session 状态，可以推送到 UI | 用来保存 session 的挂载状态和可借用列表。 |
| `ctx.computerUse` | `packages/computer-use/computer-use` | 只做名字注册，**整个部署只允许一个 provider** | 多环境 GUI 不能按 provider 拆开：要么自己注册一个名字再内部路由，要么不经过它、直接注册自己的工具。 |

### 1.2 按 agent 作用域（Scope / isolate / preset）

- `createScope(ctx, key)`（`packages/core/scope/src/index.ts:137`）的实现是 `fiber.ctx.extend({[kScope]: key})`。agent-loop 为每个 Agent 创建一个 scope，`agent.ctx` 就是这个 scope 的 context。通过它注册的工具、prompt section 和 listener 都只对该 agent 可见。
- **scope 只管「贡献的可见性」，不改变 service 实例。** 要让某个 agent 看到不同的 `ctx.fs`，需要用 Cordis 的 `ctx.isolate('fs')`（`vendor/cordis/src/context.ts:121`）。
- Agent preset（`packages/preset/agent-preset-registry`）就是「scope + isolate realm + 一组插件」的声明式写法。preset 提供的 service 必须放在 isolate realm 里，否则挂载失败。但 preset 有两个限制：
  - 同一个 preset 的所有 session 共享一份实例。
  - 第一轮对话之后就锁定（`agent-preset/locked`）。
  - 所以它不适合「每个 session 绑定一个具体环境实例」。
- 挂载的推荐写法如下。⚠ 需要原型验证：没有生产代码这样程序化使用过 isolate。

```ts
const scope = createScope(ctx, agent)          // 环境插件拥有，绑定到 agent
const realm = scope.ctx.isolate('fs').isolate('subprocess').isolate('shell').isolate('sandbox')
realm.plugin(EnvFileSystem, { env })           // 只在这个 realm 内提供 ctx.fs
realm.plugin(EnvSubprocessRuntime, { env })
realm.plugin(BashLocal)                        // 或 PwshLocal，取决于环境 OS
realm.plugin(ToolFs); realm.plugin(ToolBash)   // scoped 注册，遮蔽全局的 read / write / bash
// 卸载：scope.dispose()；Cordis fiber 会自动回收 realm 内的一切
```

### 1.3 Session / Workspace

- 创建流程：`session.create` 先算出 `cwd = workspace.path ?? cwd`，然后宿主机执行 `mkdir(cwd)`，再调用 `ctx.agents.create({meta:{cwd, agentPreset}, setup})`，最后 `workspace.attachSession`。其中 attach 会用宿主机的 `realpath` 和 `stat` 校验 header 里的 cwd。
  - 位置：`packages/api/session-controller/src/{commands,agent}.ts`，`packages/workspace/workspace/src/entity.ts:109-149`。
- `SessionCreateRequest` 没有扩展字段。`SessionHeader` 不可变，字段集合也是封闭的。
- 插件**不能新增 session 事件类型**：日志里出现未知的非 ignorable 事件会导致 session 打不开。外部插件只能用 `appendPluginRecord(session, 'plugin:<pkg>/…', data)` 写记录，再用 projection 通过 `pluginRecordOf()` 折叠出状态（`packages/core/session/src/index.ts:469-512`）。
- 「先创建空白 session，再在第一轮之前选择」的流程已有先例：ui-agent-preset 通过 Remote `agentPresets.select(sessionId, id)` 实现（`packages/client/ui-agent-preset/src/client/seat-store.ts`）。挂载可以照搬这个流程。
- 第三方插件无法向 session-controller 注入 `setup`。等价的做法是监听 `ctx.on('agent/created', …, {prepend:true})`，这个事件在 create 和 resume 时都会触发，并且可以 await。
- Workspace 的记录是 strict schema，无法扩展。插件可以自建一个以 `WorkspaceId` 为 key 的 storage domain，用来存可借用列表。

### 1.4 绕过 seam 或使用根 `ctx.fs` 的消费方（挂载时需要处理）

| 包 | 问题 | 挂载时的处理 |
|---|---|---|
| `fs/tool-fs-search`（glob / grep） | 通过 `ctx.subprocess` 启动的是**宿主机上 rg 的路径**（`search-core.ts:171-240`）；cwd 回退到 `process.cwd()`；结果用宿主机的 `node:path` 处理 | **必须自己实现**挂载版的 glob / grep，走环境接口的 `glob` / `grep` |
| `skill/skill-filesystem` | project skill 通过**根** `ctx.fs` 读取，所以挂载后读到的是宿主机；user / bundled 根和 watcher 直接用 `node:fs` | 见 §4.4 |
| `context/agent-instructions`（AGENTS.md） | 有 `ctx.fs` 就用 `ctx.fs`，但插件本身挂在根上 | 由 scoped 的 system prompt section 重新提供，⚠ 待验证它能否作为 scoped 插件重新挂载 |
| `context/file-reference-local`（`@` 补全） | 直接读宿主机目录 | 第一版可以接受，或者由挂载插件改为提供 scoped 的 provider |
| `deliverables/workspace-changes`（每轮 diff） | git 走 subprocess，但临时 index 用的是宿主机 `node:fs`，两个世界混在一起 | 挂载时禁用，或者另写一个实现 |
| `api/workspace-files`、`api/terminal-controller`（GUI 文件侧栏和终端） | 使用根 seam，而且调用时没有 agent initiator | 第一版放着不管；之后让 UI 走我们自己的 Remote |
| `spill-policy` | 超长输出写到宿主机临时目录，返回给模型的是宿主机路径 | 挂载的 fs 需要实现 `processPathFromHostPath`，或者对 spill 目录做透明映射 |
| `skill-office`、`tool-workspace-dependencies` | 技能正文里引用的是宿主机上的 Python / Node 路径 | 挂载时屏蔽，或改写说明 |
| hooks（claude-code / codex） | 走 `ctx.shell`，挂载后会跑到远端 | 需要明确语义，建议 hooks 留在宿主机 |

---

## 2. 外部同类项目（详见文末链接）

| 类别 | 代表 | 可借鉴之处 |
|---|---|---|
| 通用远程 fs / proc / tunnel 守护进程 | **distant**、Mutagen、`ssh -L/-R`、adb forward/reverse | distant 的协议：`proc_spawn → proc_stdout{id} → proc_done`，`tunnel_open` / `tunnel_listen`（port 0 返回真实端口），search / cancel_search，capability 标志，`launch` / `connect` 两个动词组成的 driver 契约。缺口：stdin EOF、信号、反压、按 offset 读写、UDP |
| Agent 远程运行时 | **SWE-ReX**、OpenHands runtime、E2B（envd）、Daytona、Modal | 把 Deployment（生命周期）和 Runtime（I/O）分开；本地和远端实现同一个接口；持久化的 named shell session |
| IDE 远程开发 | **Zed remote**、VS Code Remote、JetBrains Gateway | 守护进程二进制固定版本，目标机离线时通过传输通道上传；用 stdio proxy 重新附着到 daemon 实现重连；路径用 `authority + path` 寻址 |
| 设备农场与租借 | **STF**、**Selenium Grid 4**、**labgrid**、Appium device-farm、AWS Device Farm | STF：`present` / `ready` / `using` / `owner` 状态，带超时 acquire，持有租约期间才发放 adb 端点。Grid：按 capability 匹配的 FIFO 队列，带超时。labgrid：reserve 得到 token，到期不续就失效 |
| Android agent 工具 | **mobile-mcp**、scrcpy、uiautomator2、droidrun | mobile-mcp 的工具集：install / launch / screenshot / elements / tap / swipe / type / logs / batch，加上 allocate / release。scrcpy 的做法：push jar，`app_process` 启动，通过 `localabstract` socket 隧道通信 |
| Windows GUI | **cua**（cua-spacesd / cua-driver / Pool）、Windows Agent Arena、UFO、Windows-MCP、Windows Sandbox | GUI helper **必须运行在交互式登录会话里**（session 0 隔离），通常在登录时自启；UIA 控件树优先，截图作为兜底 |

结论：没有现成项目能直接嵌进 DSH。**接口设计参考 distant，生命周期参考 SWE-ReX 和 Zed，借用模型参考 STF、Grid 和 labgrid，Android 工具参考 mobile-mcp。**

---

## 3. 建议架构

```
┌──────────────────────── dsh-plugin-environments（宿主机）────────────────────────┐
│ ctx.environments  (Service)                                                    │
│   ├─ drivers: local │ env-server │ ssh │ adb │ win-user                        │
│   ├─ registry: 环境定义 (storageDomain) + 连接池 (每个连接一个 Cordis fiber)     │
│   ├─ leases: 借用 / 排队 / 心跳 / 归还 / 清理钩子                               │
│   └─ Remote API (给 UI): list / mount / borrowable / listDirectory / status    │
│ adapters: EnvFileSystem extends FileSystem, EnvSubprocessRuntime extends ...   │
│ mount:  agent/created → createScope + isolate + 重挂 tool-fs/bash/terminal +     │
│         自研 glob/grep/skill/instructions                                      │
│ borrow: env_list / env_borrow / env_return / env_transfer (+ 每个租约的专属工具) │
│ client: hero 上的环境选择器 + 远端目录浏览器                                    │
└────────────────────────────────────────────────────────────────────────────────┘
```

### 3.1 通用环境接口（第一版）

以 distant 为蓝本，并补上它缺少的部分。所有句柄都绑定到调用方的 Cordis ctx，调用方 dispose 时自动清理。

```ts
interface Environment {
  readonly id: string
  readonly info: EnvInfo            // os/arch/shell/pathSep/home/默认 root，类似 distant 的 system_info
  readonly caps: EnvCapabilities    // pty, tcpForward, tcpReverse, udp, watch, glob, grep, gui, ...

  // fs：二进制优先，支持按范围读写
  stat(path, o?): Promise<EnvStat | undefined>
  readDir(path, o?): Promise<EnvDirEntry[]>
  readFile(path, o?: { offset?, length?, maxBytes? }): Promise<Uint8Array>
  openRead(path): Promise<AsyncIterable<Uint8Array>>          // 大文件和跨环境传输用
  writeFile(path, data: Uint8Array | AsyncIterable<Uint8Array>, o?: { mode?: 'create'|'overwrite'|'append', atomic?: boolean }): Promise<void>
  mkdir / remove / rename / realpath ...

  // 搜索：流式，可取消
  glob(pattern, o: { cwd, signal }): AsyncIterable<string>
  grep(query, o: { cwd, glob?, signal }): AsyncIterable<GrepMatch>

  // 进程：双工
  spawn(spec: { argv | command, cwd?, env?, pty?: {rows, cols} }, ctx): EnvProcess
  //   EnvProcess: stdin(Writable，可 end) / stdout / stderr / resize / signal / kill / exited

  // 隧道
  forward(spec: { local: {host, port|0}, remote: {host, port}, proto: 'tcp'|'udp' }, ctx): Promise<Tunnel>  // 本地 → 对端
  reverse(spec: { remote: {host, port|0}, local: {host, port}, proto }, ctx): Promise<Tunnel>              // 对端 → 本地
}
```

- 挂载时，用 `EnvFileSystem` 和 `EnvSubprocessRuntime` 把它适配成 DSH 的 `FileSystem` 和 `SubprocessRuntime`，这样现有的 read / write / edit / bash / terminal / LSP 都能直接使用。
- 版本 token 用 `mtime + size`（或者 env-server 提供的 inode 和 mtime）实现，保证 `fs-observation-policy` 的「先读后写」检查能正常工作。
- 对 DSH 最重要的约束：
  - 写入要原子（先写临时文件再 rename）。
  - spawn 要支持取消和受管清理（进程树、Job object）。

### 3.2 四种提供方式

| 驱动 | 实现建议 | 说明 |
|---|---|---|
| **local** | 直接复用 `fs-local` / `subprocess-local`；glob / grep 用本机 rg | 「借用本机」时只要包一层工具即可；挂载 local 等同于默认行为 |
| **environment-server** | 自研守护进程：单连接多路复用（channel id + 基于额度的流控），TLS 或 token 认证；内部可以直接复用 DSH 的 `fs-local` / `subprocess-local`，参照 ssh helper 的写法 | **建议把它作为通用实现。** 它可以跑在 Windows、Linux、mac 上，原生支持 UDP 隧道、glob / grep（内置 rg）和 watch |
| **ssh** | **不能直接用仓库里的 ssh 家族**，因为宿主机是 Windows，而它要求两端都是 POSIX。建议用纯 JS 的 `ssh2`：sftp 负责 fs，exec 负责 spawn（含 pty），`forwardOut` / `forwardIn` 负责隧道。另外，如果能装 env-server，就通过 ssh exec 的 stdio 拉起 env-server（Zed / distant 的做法），从而统一到上一条 | 能装 env-server 时走 env-server，装不了时用纯 sftp + exec 降级（glob / grep 用远端的 rg、find 或 grep） |
| **adb** | 用 adb CLI 或 `@devicefarmer/adbkit`：sync 服务负责 fs，shell v2 负责 spawn（stdout / stderr 分离、带退出码），`forward` / `reverse` 负责 TCP 隧道。glob / grep 用 toybox 的 find / grep。专属工具有 install_apk、screenshot（`exec-out screencap -p`）、input、uiautomator dump、logcat | 不支持 UDP。如果之后需要更强的能力，可以参照 scrcpy push 一个 helper 上去 |

### 3.3 挂载（Mount）

1. **选择时机**：和 agent preset 一样，只能在空白 session、第一轮之前选择。
   - Remote 调用 `environments.mount(sessionId, envId, root)`，写入 `plugin:dsh-env/mount` 记录，同时 projection 推送给 UI。
   - resume 时在 `agent/created` 里读取 projection 并重新安装。
2. **cwd 问题（最关键）**：header 里的 cwd 必须是宿主机目录，所以推荐在宿主机上建**占位目录 + 路径映射**：
   - 每个 `(envId, remoteRoot)` 在宿主机上对应一个占位目录，例如 `~/.dsh/env-mounts/<envId>/<hash>/`，用它作为 workspace 和 session 的 cwd。
   - `EnvFileSystem.resolve(path, {cwd})` 把占位 cwd 翻译成 remote root，绝对路径按远端的写法解释。`EnvSubprocessRuntime.spawn({cwd})` 做同样的翻译。
   - 这样 tool-fs、bash 和 sandboxPolicy 都不需要修改。
   - 代价：所有不走 seam 的东西（GUI 文件树、diff、`@` 补全）看到的都是空的占位目录。第一版可以接受，后续再逐个替换。
3. **要替换的工具**：
   - 在 isolate realm 里重新挂载：tool-fs（read / read_image / write / edit）、tool-bash 或 tool-pwsh（取决于远端 OS），以及 terminal backend 加 tool-terminal。
   - 自己实现：glob、grep，以及 skill 和 AGENTS.md 的读取（见 §4.4）。
   - 挂载期间，用 `restrict({deny})` 屏蔽不适用的全局工具，例如 workspace-dependencies。
4. **覆盖工作区选择**：用更低的 priority 覆盖 `conversation.hero.workspace` 这个 single slot，做成「工作区 + 环境」的组合选择器。
   - 远端目录浏览要自己做一个对话框，因为 `ui-directory-picker-browse` 的 `BrowseDirectoryFlow` 是包内私有的。数据由我们自己的 Remote `listDirectory(envId, path)` 提供。

### 3.4 借用（Borrow）

1. **可借用列表**：
   - workspace 级别的列表存在自建的 storageDomain 表里，key 是 `WorkspaceId`。
   - session 级别的列表默认继承 workspace，可以随时通过 `plugin:dsh-env/borrowable` 记录覆盖，由 projection 维护。
2. **租约管理器**：
   - 每个环境有「容量」（通常是 1），并带标签或 capability，例如 `android`、`api>=33`、`emulator`。
   - 请求用 selector 描述，进入 FIFO 队列，可以设置 `wait: false | timeoutMs`。
   - 心跳续约，超时自动回收（labgrid 的做法），防止崩溃的 agent 一直占着设备。
   - 每个租约是一个 Cordis fiber / scope：归还、agent dispose 或超时都会触发清理，包括关闭隧道、杀进程，以及按设备类型执行的 reset 钩子（例如卸载本次安装的 APK）。
   - 进程内可以复用 `browser-use-runtime` 的 `SessionResources` 中 `exclusive` 的思路。
   - 跨 DSH 进程或跨机器共享设备池时，需要中心化的锁。最简单的做法是由 env-server 自己维护 lease。
3. **工具**：
   - 常驻工具：`env_list`、`env_borrow(selector, wait?, timeout?)`、`env_return(lease)`、`env_transfer(src: lease:path, dst: lease:path)`（经宿主机流式中转，目录走 tar 快速路径）、`env_tunnel(lease, …)`。
   - 借用成功后，在 `createScope(ctx, agent)` 里注册该环境的专属工具。所有工具都带 `lease` 参数，或者以别名作为前缀（例如 `android1__install_apk`），这样多个租约可以并存。归还时 `scope.dispose()`，工具随之消失。
   - 「双工 spawn」对模型的暴露方式参照 Desktop Commander：`env_spawn` 返回 pid，配合 `env_proc_write`、`env_proc_read(timeout)` 和 `env_proc_kill`。也可以接入现有的 `ctx.jobs`（后台作业）。
4. **KV cache**：工具集一变就会开启新的 request series，导致前缀缓存失效（`agent-loop/src/agent.ts:289-293`）。
   - 如果借用很频繁，可以考虑让专属工具「按类型」注册：同类设备共用一套带 `lease` 参数的工具，第一次借用后就保留不撤。这是一个需要权衡的点。

### 3.5 Windows 受限账户 + GUI

- 现有的 `sandbox-windows-acl` 是「受限令牌 + Low IL + ACL」方案。它的设计记录**明确拒绝了新建身份的方案**，并且完全不处理 window station 和桌面。
  - 可复用的部分：`packages/subprocess/win32-process` 里基于 koffi 的 `CreateProcessAsUserW`、Job object 和 STARTUPINFO 绑定。
- 创建和管理账户：`NetUserAdd`、`NetLocalGroupAddMembers`、`LogonUserW`、`LoadUserProfileW`，必要时配合 `CreateProcessWithLogonW`。另外需要设置 ACL 授权，并在环境回收时清理。
- **GUI 是难点**：GUI 程序必须运行在该账户的**交互式会话**里，而服务和 ssh 拉起的进程都在 session 0 或非交互会话中。⚠ 以下几条需要实测：
  1. Windows 客户端 SKU 同一时间只允许一个活动交互会话。RDP 回环或快速用户切换会把当前用户挤下线，或者让当前用户的会话处于非活动状态。
  2. 一个可行方案是用 `CreateProcessWithLogonW` 让受限账户的进程出现在**当前用户的桌面**上，类似 runas。代价是共享桌面，还要处理 UIPI 和完整性级别带来的交互限制。
  3. 隔离最好的方案是 Hyper-V VM 或 Windows Sandbox，并在里面登录时自启 env-server 和 GUI helper（Windows Agent Arena 和 cua 都是这么做的）。这样它退化成「一个 env-server 环境」。
- 结论：**Windows 受限账户适合排在第二期。** 第一期可以先做「无 GUI 的受限账户 + env-server」，或者「VM + env-server」。GUI 操作工具建议自己实现，比如截图、UIA 树、输入，或者在 env 里运行 `cua-driver mcp` 并转接。不要依赖全局唯一的 `ctx.computerUse`。

### 3.6 技能等「读文件行为」在挂载下的处理（§1.4 的补充）

- **项目技能**（`.agents/skills` 和 `.dsh/skills` 在远端仓库里）：skill-filesystem 插件挂在根上，用的是宿主机的 fs。
  - 选项 A：挂载插件注册一个 scoped 的 skill provider，从环境里读取。⚠ 需确认 `ctx.skills` 的 provider 注册是否支持按 scope 生效。
  - 选项 B：在 isolate realm 里重新挂一份 skill-filesystem。
- **用户和内置技能**：保持在宿主机。但技能正文里提到的宿主机脚本路径（例如 office 系列）在远端不可执行，挂载时需要过滤，或者给出提示。
- **AGENTS.md**：在 realm 内重新挂载 agent-instructions，让它读取 realm 的 `ctx.fs`。⚠ 待验证。
- **一般原则**：凡是根上的插件「通过 `ctx.fs` 读取 session cwd」的情况，都要在 realm 内重挂或者写 scoped 替身。可以把它整理成一张清单，跟着 DSH 版本维护。

---

## 4. 风险与需要先验证的点

| # | 问题 | 验证方式 |
|---|---|---|
| R1 | 程序化地 `createScope(...).ctx.isolate('fs')` 加上重挂 tool-fs / tool-bash，是否正确遮蔽全局工具，并且 dispose 时干净？preset registry 的「泄漏审计」逻辑可以参考 `mount.ts:204-216` | **第一个原型**：用 local 环境加一个「把所有路径映射到另一个目录」的假 fs 跑通挂载 |
| R2 | 占位 cwd + 路径映射方案是否会被哪个工具直接用 `header.cwd` 访问宿主机？ | 对 R1 的原型跑一遍 read / write / edit / bash / terminal / lsp |
| R3 | 宿主机是 Windows 时，远端 POSIX 的路径语义（例如 tool-bash 的 `resolveWorkdir` 用宿主机的 `isAbsolute` / `sep`）是否会出问题？ | 用 ssh 或 env-server 连接 Linux 测试 |
| R4 | 借用导致工具集变化时 KV cache 的影响，以及当前路由是否支持 `toolUpdate` | 观察 `request/header` 和缓存命中 |
| R5 | Windows 交互会话限制 | 在目标 Windows 版本上实测 |
| R6 | 插件记录和 projection 在 session 格式迁移中只能 best-effort 保留 | 接受；resume 时做容错 |

---

## 5. 建议的推进顺序

1. **P0 原型（1 到 2 天）**：用 local 加路径映射验证挂载机制（R1、R2）；用一个 `echo` 环境验证借用时工具的动态出现和消失。
2. **P1**：
   - 定义环境接口和 capability。
   - 实现 env-server 的最小版本（复用 fs-local / subprocess-local），加 TCP + token 传输。
   - 实现 ssh 驱动（ssh2：sftp 和 exec，加上「通过 ssh 拉起 env-server」）。
   - 实现租约管理器和借用工具，以及 `env_transfer`。
3. **P2**：
   - 实现 adb 驱动和 Android 专属工具（install_apk、screenshot、input、ui dump、logcat）。
   - 实现隧道（TCP 正向和反向；UDP 只在 env-server 上提供）。
4. **P3**：
   - 实现 UI：环境选择器、远端目录浏览、借用状态展示。
   - 处理挂载下技能、AGENTS.md、`@` 补全和 diff 的替身。
5. **P4**：Windows 受限账户（先无 GUI，再按 §3.5 选择 GUI 方案）。

## 6. 需要你拍板的问题

1. 宿主机是否只考虑 Windows？这决定了是否完全放弃仓库里的 POSIX ssh 家族，改用 ssh2 / env-server。
2. env-server 用什么语言？
   - 用 Node：可以直接复用 DSH 的 fs-local / subprocess-local，但目标机必须有 Node。
   - 用 Go / Rust 单二进制：部署简单，但要重写原子写入、进程树清理等语义。
3. 第一版挂载是否要求 GUI 的文件树、diff 和终端也跟随远端？如果要求，就需要改造或替换 `api/workspace-files` 等宿主机侧服务，工作量会明显增加。
4. 设备池是否要跨多个 dsh 进程或多台机器共享？如果是，租约需要中心化，可以放在 env-server 或一个单独的 pool 服务里。
5. 借用工具的形态：每个租约一套带前缀的工具（直观，但缓存失效更多），还是按设备类型共用一套带 `lease` 参数的工具？

---

## 附：关键源码位置

- 执行世界决策：`.agents/notes/implemented/architecture/2026-07-28-portable-execution-world-consumers.md`
- SSH 决策和实现：`.agents/notes/implemented/architecture/2026-09-11-posix-ssh-runtime.md`，`packages/ssh/*`，`docs/subsystems/ssh.md`
- E2B 移除决策（远端提供方的重新引入条件）：`.agents/notes/implemented/simplification/2026-09-11-remove-e2b-providers.md`
- fs seam：`packages/fs/fs/src/index.ts`，`docs/subsystems/filesystem.md`
- subprocess seam：`packages/subprocess/subprocess/src/{index,types}.ts`
- Scope：`packages/core/scope/src/index.ts`，`docs/subsystems/scope.md`
- 工具注册和遮蔽：`packages/core/tools/src/index.ts`，`docs/subsystems/tools.md`
- Preset 和 isolate：`packages/preset/agent-preset-registry/{README.md,src/mount.ts,src/session.ts}`，`packages/bundle/web-app/presets/standard.patch.yml`
- 按 agent 的资源和工具模板：`packages/experimental/browser-use-runtime/src/{index,mcp}.ts`
- 图片结果：`packages/fs/tool-fs/src/read-image.ts`，`packages/mcp/mcp-client/src/tools.ts`
- Session 创建：`packages/api/session-controller/src/{commands,agent}.ts`
- 插件记录：`packages/core/session/src/index.ts:469-512`
- Windows 令牌和进程：`packages/sandbox/sandbox-windows-acl/src/token.ts`，`packages/subprocess/win32-process/src/process.ts`
- UI slots：`packages/client/ui-conversation/src/client/apply.ts:309-321`，`packages/client/ui-workspace/src/client/WorkspacePicker.tsx`，`docs/subsystems/slots.md`
- 外部插件打包：`docs/user/develop/basic/{index,publish}.md`，`packages/experimental/auto-review`

## 附：外部链接

- distant：<https://github.com/chipsenkbeil/distant/blob/master/docs/PROTOCOL.md>，<https://github.com/chipsenkbeil/distant/blob/master/docs/PLUGINS.md>
- SWE-ReX：<https://swe-rex.com/latest/architecture/>
- OpenHands runtime：<https://docs.openhands.dev/openhands/usage/architecture/runtime>
- Zed remote：<https://zed.dev/docs/remote-development.md>
- STF API：<https://github.com/DeviceFarmer/stf/blob/master/doc/API.md>
- Selenium Grid：<https://www.selenium.dev/documentation/grid/components/>
- labgrid：<https://github.com/labgrid-project/labgrid>
- mobile-mcp：<https://github.com/mobile-next/mobile-mcp>
- scrcpy：<https://github.com/Genymobile/scrcpy/blob/master/doc/develop.md>
- cua：<https://github.com/trycua/cua>
- Windows Agent Arena：<https://github.com/microsoft/WindowsAgentArena>
- E2B：<https://e2b.dev/docs>；Daytona：<https://www.daytona.io/docs>；Modal Sandboxes：<https://modal.com/docs/guide/sandbox>
- ssh2（Node）：<https://github.com/mscdex/ssh2>；adbkit：<https://github.com/DeviceFarmer/adbkit>

> 注：外部条目中，distant、SWE-ReX、OpenHands、STF、Selenium Grid、mobile-mcp、cua、Zed 的资料在本次调研中实际读过原文；其余条目来自已有知识，细节请以官方文档为准。
