# 独立会话模式（每个隔离账户一个真正的 Windows 会话）

Windows 账户环境有两种「桌面」：

| 模式                       | 每个账户的窗口在哪                | 鼠标指针       | 输入                    | 需要什么            |
| -------------------------- | --------------------------------- | -------------- | ----------------------- | ------------------- |
| **独立桌面**（默认即可用） | 同一会话内的 `WinSta0\dsh-<账户>` | 只有合成指针   | 窗口消息                | 什么都不用装        |
| **独立会话**（本页）       | 自己的 Windows 会话               | **真正的指针** | 真实键鼠（`SendInput`） | RDP 主机 + TermWrap |

「环境」页面会探测这台机器能不能用独立会话模式；不能时会列出缺什么，并给出**一键安装
TermWrap** 的入口。

## 为什么需要 TermWrap

真正独立的桌面必须是一个**独立的 Terminal Services 会话**（独立 `WinSta0`、独立输入桌面、
独立光标）。会话只能由登录栈（winlogon / termsrv）创建，没有 API 能让普通进程凭空造一个。

而客户端 SKU（家庭版/专业版都一样）有两个限制：

1. 同时只允许**一个**交互会话——第二个用户登录会把控制台用户踢下线；
2. 家庭版连 RDP 主机都不开放。

TermWrap 用「替换 Terminal Services 的服务 DLL + 在内存里打补丁」绕过这两条，并且**自己
在加载的 `termsrv.dll` 里搜补丁偏移**，所以不需要按版本维护 `rdpwrap.ini`。它不改磁盘上的
系统文件，但每次 Windows 累积更新后仍应重新验证一次。

## 一键安装做什么

`session install`（需要管理员授权；`--no-exclusion` 跳过 Defender 排除项，`--no-restart` 跳过
最后那步服务重启）严格按 TermWrap 自己的文档执行：

0. **先把 `%ProgramFiles%\RDP Wrapper\` 加入 Defender 排除项**——微软对这个家族有官方特征
   `HackTool:Win64/RDPWrap!MTB`，不先加白名单，DLL 落盘就会被隔离，安装会「看起来成功」但服务
   起不来。这一步是显式的、会写进安装结果，也可以随时用
   `Remove-MpPreference -ExclusionPath '<目录>'` 撤销；
1. 确认随包 payload 里有 `TermWrap.dll`（没有就拒绝安装）；
2. 把 DLL 复制到 `%ProgramFiles%\RDP Wrapper\`；
3. 导入 payload 自带的 `Install_termwrap_umwrap.reg`（把 `TermService`/`UmRdpService` 指向
   Wrapper DLL；payload 里没有 `.reg` 时退化为直接写这两个 `ServiceDll` 值）；
4. `fDenyTSConnections=0`，必要时创建本机组 `Remote Desktop Users`（家庭版没有这个组）；
5. 启动 `TermService`（有 `UmWrap.dll` 时也启动 `UmRdpService`）；
6. **重启 `TermService`/`UmRdpService` 让补丁立即生效**——SCM 在每次服务启动时都会重新读
   `ServiceDll`，所以「停一下再起」就等于把 Wrapper DLL 加载进来。`UmRdpService` 依赖
   `TermService`，因此先停它、最后起它；起来后再确认 3389 已经重新在监听。上游文档写的是
   「重启电脑」，那只是因为**服务启动**才是 DLL 的加载点，而服务重启同样是服务启动。
   不想让它动服务时用 `--no-restart`：那样只会「启动」（不重启）服务，通常还得自己重启电脑才
   生效。
7. 报告结果：服务回来了并且监听恢复 → `rebootRequired: false`，无需重启电脑；**停不下来或
   起不来**（没有管理员权限、被安全软件拦下、DLL 被占用……）才回退到「重启电脑」。

重装时**内容相同的文件不会被重写**（所以常见的「同一个包再装一次」根本不碰服务）；只有真要替换
的文件被占用（正在运行的 DLL 是锁住的）时，安装才会**先停服务再拷**，并且最多重试 3 次——
`TermService` 是**触发启动**的：任何一次 RPC/WTS 调用（环境页面探测自己的状态就够）都会把它拉
起来，所以停一次不一定压得住。注意第 6 步会**掐断当时正在跑的 RDP 会话**——环境正在用独立会话
模式时不要重装，重装时也尽量别同时刷环境页面。

安装后回到「环境」页面重新探测即可看到状态变化。

## 每个账户还要单独放行（`session allow`，需要管理员授权）

连接能不能建立，看的是**监听器自己的安全描述符** `WinStations\RDP-Tcp\Security`：默认只把
`WINSTATION_QUERY | CONNECT | LOGON`（`0x121`）给 Administrators 和**内置**的 Remote Desktop
Users 别名（S-1-5-32-555）。家庭版根本没有这个别名——安装时创建的那个同名组是普通本机组
（SID 是 `S-1-5-21-…`），加进去不满足那条 ACE。所以每个账户第一次连接前，`session allow`
（管理员）会做三件事，缺一条都会被拒：

1. 加入本机组 `Remote Desktop Users`（Pro/Server 上这条就够）；
2. 把「允许通过远程桌面服务登录」(`SeRemoteInteractiveLogonRight`) **直接授予账户本身**
   （家庭版靠这条；组本身不携带这项权限）；
3. 在监听器描述符里**给该账户的 SID 加一条 `0x121` 的 ACE**。

前两条缺失时，服务器在 CredSSP 的 early user auth 阶段直接回 `access denied`——密码根本没被
校验，客户端只看到「access denied」，很容易误判成密码错。第 3 条若没写对，现象一样。

**改这个描述符必须整体保留**：它是自相对的 `SECURITY_DESCRIPTOR`，带 owner（`O:SY`）、group
和一条审计 SACL（`S:(AU;FA;CCWPCR;;;WD)`）。先 `MakeAbsoluteSD` 复制成绝对形式、只替换 DACL，
再 `MakeSelfRelativeSD` 写回；只写一个 `D:(…)` 描述符虽然能被注册表接受，但 `TermService`
会拒绝之后**所有**连接（包括本来就正常的账户），而且必须重启服务或重启机器才能恢复。

## 会话的生命周期

shell 命令带 `--no-console --end-session`：前者让 Windows 给控制台程序分配的那个窗口（Win11 上是
Windows Terminal）不出现在账户桌面上，后者让**服务端退出时把这个会话也结束掉**。这第二个参数不
是洁癖：Windows 不保证 shell 退出后会话就结束（它可能停在登录界面），而留下来的会话比没有更糟——
下一次登录会**重连**到它，于是 shell 根本不会运行，环境服务端也就永远不会监听我们的端口，客户端
只会看到「连不上」并重试到超时（表现就是「卡住」）。

万一还是留下了这样的会话（例如连接中途被杀），`winuser session` 会先检查该账户是否已有会话，
有就返回 `{"code":"session-busy","sessions":[…]}` 而不是硬登；插件收到后调用需要管理员权限的
`session logoff --account <账户>` 结束它，再重试一次。手工排障时可以直接用这条命令，例如：

```sh
dsh-env-server session logoff --account dsh-test1   # 需要管理员
```

## 打包与分发

Payload **不加密**，连同 `LICENSE` 明文**打在插件包里**（`vendor/termwrap/`，
`pnpm run package` 会带上它并校验它确实进了 tarball）。**安装时不联网**，全部读随包文件。

```sh
# 打包前（在联网的构建机上）：
node scripts/stage-termwrap.ts --from <下载的发布包> --version <版本>
```

- 主插件包里含它（可选关闭），因为微软 Defender 对这个家族有官方特征
  `HackTool:Win64/RDPWrap!MTB`；安装流程会先给安装目录加白名单（见上），所以不需要额外步骤。
- 我们不安装 `EndpWrap.dll`（音频录制重定向）：上游自己警告它会加载进每个播放远程音频的
  程序并可能导致卡死，而且需要往 `System32` 放文件。

## 手工安装（没有 payload 时）

1. 确认已安装 [Microsoft Visual C++ 2015-2022 可再发行组件 (x64)](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist)
   ——TermWrap 是 C++ 写的；
2. 下载 TermWrap 发布包，把 DLL 复制到 `%ProgramFiles%\RDP Wrapper\`；
3. 合并 `Install_termwrap_umwrap.reg`（家庭版/服务器版需要 UmWrap；专业版/企业版用
   `Install_termwrap_only.reg`）；
4. 重启这两个服务（`UmRdpService` 依赖 `TermService`，先停它、最后起它；重启电脑当然也可以），
   然后在「环境」页面重新探测：

   ```powershell
   Stop-Service UmRdpService -Force; Stop-Service TermService -Force
   Start-Service TermService; Start-Service UmRdpService
   ```

## 已知代价

- 第三方、未签名补丁，微软官方不支持；Defender 会把它识别为 `HackTool`。
- Windows 更新可能让偏移失效，需要更新 TermWrap 后重装（重装会自己把服务重启，不必重启电脑）。
- 会话模式占内存（每会话约 100–200 MB），且必须保持会话「已连接」（断开的 RDP 会话不再
  渲染，截图会黑）。登录由 `dsh-env-server` 自带的**无界面 RDP 客户端**完成（IronRDP，见
  `crates/dsh-env-server/src/rdp.rs`），它同时负责一直把连接挂着；`mstsc` 不再参与。
- 会话里的 shell 不是 `explorer.exe`，而是环境服务端本身：登录前会把账户自己的
  `HKCU\Software\Microsoft\Windows NT\CurrentVersion\Winlogon\Shell` 指向
  `<服务端> serve … --no-console`。用注册表而不是 RDP 协议的 `alternate shell`，是因为当前
  Windows 已经不再采信客户端那个字段（实测会话照样起 explorer）。`--no-console` 让 Windows
  为控制台程序分配的窗口（Win11 上是 Windows Terminal）从这个会话的桌面上消失，否则它会一直
  挡在智能体自己的窗口旁边。
- 这个 shell 是**每个账户一份**的持久设置：账户下次登录（包括在控制台登录）跑的还是这条命令。
  `winuser delete --purge-profile` 会连同配置文件一起删掉。
- 家庭版可能缺 `rfxvmt.dll`：Windows 家庭版不附带它，有的机器缺它时监听器会一直
  `[not listening]`。只有在 3389 没在监听时，探测才会把它列为 `rfxvmt-missing`；监听器已经起来
  就说明不需要它（实测 26100 家庭版 + TermWrap 不需要）。
- 家庭版上安装创建的 `Remote Desktop Users` 组只是同名的普通本机组（SID 是 `S-1-5-21-…`，不是
  内置的 `S-1-5-32-555`），而「允许通过远程桌面服务登录」(`SeRemoteInteractiveLogonRight`)
  在默认策略里只授予内置 SID，所以光加入这个组没有用。`session allow` 因此除了加组，还会把这项
  权限直接授予账户本身，在所有版本上都成立。
- 法律/授权：客户端 SKU 同时多会话不在 Windows 客户端授权范围内（RDS CAL 只适用于
  Windows Server 会话主机，救不了这一条）。是否使用请自行判断。

独立桌面模式不受以上任何一条影响：它零补丁、零管理员，只是没有真指针和真实输入。
