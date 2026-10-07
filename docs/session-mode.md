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

`session install`（需要管理员授权，`--no-exclusion` 可跳过排除项）严格按 TermWrap 自己的文档执行：

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
6. 报告结果并提示**必须重启**——Wrapper DLL 只在服务启动时被加载。

安装后回到「环境」页面重新探测即可看到状态变化。

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
4. 重启，然后在「环境」页面重新探测。

## 已知代价

- 第三方、未签名补丁，微软官方不支持；Defender 会把它识别为 `HackTool`。
- Windows 更新可能让偏移失效，需要更新 TermWrap 后重装/重启。
- 会话模式占内存（每会话约 100–200 MB），且必须保持会话「已连接」（断开的 RDP 会话不再
  渲染，截图会黑）。插件用回环 `mstsc` 维持连接。
- 家庭版还需要 `rfxvmt.dll`：Windows 家庭版不附带它，缺它时监听器会一直 `[not listening]`。
  探测会把这一项列为 `rfxvmt-missing`。
- 法律/授权：客户端 SKU 同时多会话不在 Windows 客户端授权范围内（RDS CAL 只适用于
  Windows Server 会话主机，救不了这一条）。是否使用请自行判断。

独立桌面模式不受以上任何一条影响：它零补丁、零管理员，只是没有真指针和真实输入。
