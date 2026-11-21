# pi Workbench

> 作者：[LuoFeng (VincentLF0615)](https://github.com/VincentLF0615) · MIT License

用 Rust + Tauri 2 给 [pi coding agent](https://github.com/earendil-works/pi) 写一个桌面工作台（Windows 优先）。

本项目**不重写 agent**：界面通过 pi 官方 RPC 模式驱动 `pi`，模型、扩展、技能、登录态、会话文件全部复用终端里的那一套。

**致谢**：本项目的存在完全建立在 [earendil-works/pi](https://github.com/earendil-works/pi)（MIT License，© 2025 Mario Zechner）之上——它是一个极简、可扩展的 agent harness，RPC 协议设计得干净漂亮，才有了这个桌面壳。安装包内附一份 pi（见下方「内置 pi」），其 MIT 许可证原文随包分发（`vendor-pi/LICENSE`，另存于 `docs/third-party/pi-agent-LICENSE.txt`）。

```
┌────────────────────────── React 前端 ──────────────────────────┐
│ 侧栏(项目/会话) │ 会话标签 │ 转录区(消息/工具卡片) │ 输入框 │ 工具栏 │
└───────────────┬───────────────────────────────┬────────────────┘
                │ invoke(cmd)                    │ listen("pi://event")
┌───────────────▼───────────────────────────────▼────────────────┐
│                    Tauri 后端 (src-tauri)                       │
│  SessionState: 每个打开的会话一个 pi 进程                        │
│  commands: 24 个 Tauri 命令（会话/提示/模型/压缩/导出/扩展 UI）   │
│  pump 线程: 按 16ms 窗口批量转发事件                             │
└───────────────┬────────────────────────────────────────────────┘
                │ 依赖（纯 Rust，可单测）
┌───────────────▼────────────────────────────────────────────────┐
│                     crates/pi-rpc                               │
│  discover → spawn(node + pi-launcher.js, CREATE_NO_WINDOW)      │
│  JsonlCodec(只在 \n 分帧, 去 \r)                                │
│  RpcClient(id ↔ oneshot 关联) + 事件队列                        │
│  ExtensionUi 子协议 + stderr 环形缓冲 + 优雅关闭 + 杀进程树       │
└───────────────┬────────────────────────────────────────────────┘
                │ JSONL over pipes
        pi 子进程：node pi-launcher.js --mode rpc [--session ...]
```

## 当前版本：0.1.1

本轮修复会话锁、分叉/克隆归属、扩展 UI 回复、会话树循环、图片发送、JSONL 长度限制、断连等待和 Git 特殊路径；补上统计字段与会话索引缓存。界面风格和官方 pi RPC 架构保持不变。

- 注册表锁只用于查找和更新；既有会话的 RPC 与停止操作不会等待其他会话的长命令。
- 分叉/克隆先恢复原会话，再打开新分支；失败后恢复原进程或重建它。首条消息之前的空分支会保留官方 RPC 条目快照。
- 纯图片和图文消息支持 PNG/JPEG/WebP/GIF，单张 10 MiB、合计 20 MiB、最多 32 张；发送失败保留各标签自己的草稿。
- stdout 以固定块读取，单条 JSONL 上限 64 MiB；stderr 最多 200 行、每行 64 KiB、合计 1 MiB。
- 使用同一份 Windows 清单构建应用和测试，避免测试程序缺失 Common Controls v6 / TaskDialogIndirect。

2026-11-16 验证：Rust 默认测试 81 项通过，2 项 opt-in 测试默认忽略；前端 14 项通过，类型检查、生产构建、fmt 和 Clippy 通过。本机 pi 1.5.2 的独立本地协议测试另外通过 1 项，覆盖恢复、克隆、分叉及空分支，不调用模型。真实模型网络冒烟未执行。

详细修改及复现命令见 `docs/reliability-0.1.1.md`。

2026-11-18 交互补充：运行中区分 steer/follow-up、显示权威队列快照、停止前取回排队文字；统一对话框焦点与 Esc 行为，移除新会话的开发机目录 fallback。84 项 Rust 测试和 25 项前端测试通过，2 项 opt-in 测试默认忽略；fmt、Clippy、TypeScript、前端生产构建通过。另用隔离设置和离线 Pi 在真实 Tauri 窗口验证了队列、停止恢复、Esc、中文/空格路径、最小窗口及压缩取消。真实模型网络冒烟、150% 缩放和真实输入法人工测试未执行。

2026-11-19 第二轮：加入原生目录选择（保留手动路径）、可键盘操作的会话菜单、应用内重命名/删除确认、回到最新、Bash 折叠、工具栏分级和减少动画支持。35 项前端测试与 84 项 Rust 测试通过，fmt、Clippy、TypeScript 和构建通过。真实 Tauri 窗口已完成原生目录选择及中文/空格路径打开；系统进入锁屏后未继续完整菜单 GUI 验收，相关行为由组件测试覆盖。真实模型、150% 缩放和真实输入法人工测试仍未覆盖。

2026-11-19 第三轮与验收：接入扩展通知级别、状态栏、窗口标题和 dock widget；增加代码复制、安全 http/https 外链和 `Row` memo。40 项前端测试与 84 项 Rust 测试通过。CDP 验收补齐菜单、重命名、删除取消、扩展、IME 组合输入与 DPR=1.5 的 960×600 渲染；真实模型备用线路 `stepfun-cn/step-3.7-flash` 通过，默认模型的超时现象另行记录。NSIS/MSI 构建完成，MSI 隔离展开后的生产应用已通过离线会话和原生目录选择 smoke，未覆盖正式安装。详细数据见 `docs/verification-2026-11-19.md`。

2026-11-21 细节与 Pi 1.6.0：修复欢迎页首条发送、文件预览 reveal、后台完成通知、标签邻居选择和命令错误反馈；家目录文件树按需读取并隐藏根节点私有/系统项，长工具参数不再撑宽转录。内置 Pi 升为 1.6.0，vendoring 增加 SHA-512 完整性、精确版本和许可证校验。86 项 Rust 测试与 63 项前端测试通过，真实 1.6.0 离线协议和最小真实模型 smoke 通过；NSIS/MSI 及包内 1.6.0 的隔离生产 smoke 通过，未覆盖正式安装。完整实机对比与产物哈希见 `docs/verification-2026-11-21.md`。

## 目录结构

```
pi-workbench/
  Cargo.toml                  workspace
  crates/pi-rpc/              协议客户端（无 UI 依赖，阻塞 IO + 线程）
    src/framer.rs             JSONL 分帧（只按 \n 切，去 \r，超长行保护）
    src/events.rs             PiEvent 枚举 + 流式增量辅助
    src/pump.rs               事件批处理（16ms 窗口，上限 64 条）
    src/wire.rs               response / event / extension_ui 分类
    src/ui.rs                 扩展 UI 请求与回复
    src/client.rs             进程、命令关联、事件队列、关闭与杀树
    src/discover.rs           pi 安装位置发现
    tests/real_pi.rs          对真实 pi 的 opt-in 冒烟测试
  apps/pi-probe/              命令行探针（协议验收工具）
  apps/desktop/               Tauri 2 + React 19 桌面应用
    src/lib/{types,api,store}.ts   协议类型 / IPC 封装 / 会话状态与事件归约
    src/components/           Markdown、Transcript、Composer（模型选择/上下文环/扩展对话框）
    src-tauri/src/            session（会话注册表）、commands（30 个命令）、sessions（会话索引）、settings（app 设置）、git（porcelain v2）、files（文件树与预览）
  tools/dev.ps1               构建/测试/lint/打包/探针/启动应用脚本
  tools/bundle.ps1             NSIS + MSI 打包（带日志与 CARGO_TARGET_DIR）
  tools/run-app.ps1            带日志启动桌面应用
  tools/install-msvc.ps1      MSVC + Windows SDK 安装脚本
  tools/make-icons.py          应用图标生成
  tools/rpc-smoke.ps1          .NET 管道版协议冒烟（备用诊断）
  docs/protocol-notes.md      pi 1.6.0 RPC 协议笔记
```

## 快速开始

```powershell
# 构建 / 测试 / lint / 打包
pwsh -File tools\dev.ps1 build
pwsh -File tools\dev.ps1 test
pwsh -File tools\dev.ps1 lint
pwsh -File tools\dev.ps1 bundle     # NSIS + MSI，产物在 %LOCALAPPDATA%\pi-workbench-target-msvc\release\bundle
pwsh -File tools\dev.ps1 smoke
pwsh -File tools\dev.ps1 web           # vite dev server only
pwsh -File tools\dev.ps1 app          # full Tauri desktop app
```

`pi-probe` 参数：`--cwd`、`--prompt`、`--session`、`--executable`、`--no-session`、`--json`、`--timeout`、`--arg`。

## M1 界面功能

- **侧栏**：项目分组（按 pi 会话文件扫描）、会话预览、搜索；原生目录选择器与手动路径输入
- **多标签**：每个标签一个独立 pi 进程，运行状态点；「⋯」和独立关闭按钮均可键盘操作
- **转录区**：流式 Markdown（代码块/列表/引用/行内代码）、思考块折叠、工具卡片（bash/read/edit 专用摘要）、Bash 输出折叠、离开底部后显示「回到最新」、压缩横幅、重试/错误提示
- **工具栏**：模型下拉（按 provider 分组）、思考档位、上下文用量环、累计费用；命令/会话树/面板/设置保留在工具栏，刷新/压缩/重命名/导出等集中在会话菜单
- **输入框**：Enter 发送 / Shift+Enter 换行（正确处理中文输入法）；运行中可选「追加指令」(steer) 或「稍后跟进」(followUp)，队列摘要可展开；Esc 先清空队列再中断，并把排队文字恢复到输入框；图片粘贴与拖拽
- **扩展对话框**：`select` / `confirm` / `input` / `editor` 内联渲染并回包
- **错误提示**：toast + 会话标签记录 lastError

## M2 工作台功能

- **标签「⋯」/右键菜单**：重命名 / 从某条消息分叉 / 克隆为新会话 / 压缩 / 导出 HTML / 删除会话文件（优先走回收站）；支持 ↑↓、Home/End、Esc，重命名和删除使用应用内对话框
- **分叉对话框**：列出会话里所有用户消息，选一条即开新标签
- **会话树面板**：只读展示 pi 的 entry 树（message / compaction / model_change / thinking_level_change），每条消息旁有「分叉」按钮
- **命令面板**（Ctrl+K）：pi 的扩展命令 / 提示模板 / 技能，按来源标注，↑↓ 选择、Enter 即作为 `/name` 发送
- **设置页**：主题（跟随系统/亮/暗）、字号、字体、侧栏宽度、是否默认展开工具详情、日志级别；写入 `%APPDATA%\pi-workbench\settings.json`，原子保存
- **侧栏宽度**可拖动调节，设置即时生效

## M3 代码工作台

- **右侧 dock**（Ctrl+B 或工具栏「面板」开关），四个标签页：
  - **文件**：项目文件树，目录可展开，自动跳过 `.git`/`node_modules`/`target` 等生成目录；目录在前、文件在后按名排序
  - **改动**：`git status --porcelain=v2` 实时状态，按 M/A/D/R/? 着色，显示分支名与改动数；点文件看 diff，双击在预览中打开
  - **预览**：文件内容（默认 512KB 上限，超限截断并提示），带语言标注；从文件树、改动列表或工具卡片点击均可打开
  - **日志**：pi 的 stderr 环形缓冲（最近 200 行），可刷新
- **工具卡片跳转**：`read`/`edit`/`write` 等带 `path` 参数的工具，路径显示为可点链接，点击即在预览面板打开
- **git diff 渲染**：等宽字体、保留原始 diff 格式，不含 ANSI 颜色转义

## M4 打包与打磨

- **应用图标**：原创「折纸 π」设计（透明背景，彩虹渐变屋顶横杠 + 紫/青双腿，源稿见 `docs/icon-reference/`），`tools/make-icons.py` 从源稿抠底、居中并重采样出 Tauri 与 Windows Store 需要的全部尺寸，含多尺寸 `.ico` 与 `.icns`
- **单实例**：`tauri-plugin-single-instance`；第二次启动自动退出并把参数转交给已运行的实例，同时 `show` + `unminimize` + `set_focus` 把窗口带到前台
- **命令行参数**：
  ```text
  pi-workbench                      恢复上次的会话
  pi-workbench E:\project           在该目录开新会话
  pi-workbench --session <file>     恢复指定会话文件
  ```
  未知参数被忽略，`--help` / `--version` 不触发打开行为
- **启动恢复**：`%APPDATA%\pi-workbench\settings.json` 记录 `last_project` 与 `open_sessions`；启动时优先命令行意图，否则重开上次的会话。关闭标签会同步移除记录
- **pi 版本兼容**：解析 `pi --version`，与测试版本 `1.6.x` 比较；主版本不同或次版本更新时在顶部横幅提示
- **内置 pi**：安装包附带一份 [pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)（MIT），没有本机 pi 的用户开箱即用。查找顺序：显式路径 → `PI_EXECUTABLE` → 本机托管安装（`~/.pi/agent`，升级优先）→ 安装包内置副本 → PATH。内置副本由 `tools\vendor-pi.ps1` 从 npm registry 拉取（`--ignore-scripts`，与官方安装流程一致），MIT 许可证原文随包分发
- **打包**：`tools\bundle.ps1` 产出 NSIS（当前用户安装，含简体中文）与 MSI

## 关键设计

- **一个打开的会话 = 一个 pi 进程**，会话之间互不阻塞；关闭标签时等待进程退出，必要时回收进程树。
- **阻塞 IO + 线程**，不引入 async 运行时：写线程管 stdin，读线程管 stdout，stderr 线程留诊断尾巴，等待线程收尸。
- **事件批处理在 pi-rpc 里**（`pump.rs`）：16ms 窗口、上限 64 条，减少 UI 更新次数；这部分可单测，不依赖 Tauri。
- **只按 `\n` 分帧**，绝不用会按 `U+2028/U+2029` 切分的通用行读取；单行上限 64 MiB，超限丢弃并重新同步。
- **命令用 `id` 关联响应**；无 id 的 `parse` 错误走全局错误事件。
- **协议容错**：未知事件、未知字段一律忽略/记日志，不崩。
- 关闭顺序：`abort`（可选）→ 关 stdin → 等 5s → 杀进程树。

## Windows 环境结论（踩过的坑，重要）

1. **DSH 工作区是 Low 完整性标签**：`E:\default-workspace`（以及在里面新建的文件）带 `Mandatory Label\Low`。Windows 会把从这种文件启动的进程降到 Low 完整性，于是 pi 无法写 `%USERPROFILE%\.pi\agent`，启动时直接 `EPERM: mkdir ...\trust.json.lock`。
   **解决**：构建产物放普通目录 —— `tools/dev.ps1` 已把 `CARGO_TARGET_DIR` 指到 `%LOCALAPPDATA%\pi-workbench-target-msvc`。打包后的应用从普通目录运行，不受影响。
2. **MSVC 是必须的**：Tauri 2 在 Windows 只支持 MSVC。本机已装：
   - VS BuildTools 2022（17.14）+ VCTools 14.44 + Win11 SDK 10.0.26100
   - `rustup default stable-x86_64-pc-windows-msvc`（rustc 1.100.0）
   - `tools/dev.ps1` 的 `Import-BuildEnvironment` 会调 `vcvars64.bat` 把 `link.exe` 加进 PATH
3. **Windows GNU 工具链编译不了依赖 Windows API 的 crate**：rustup 自带的 `as.exe` 是残缺的，任何需要 `windows-sys` 的 crate 都卡在 `dlltool/as exited with status 53`。`pi-rpc` 是纯 Rust 所以 GNU 下能编，但 Tauri 不行。
4. **受限沙箱里命名管道不可用**：.NET/Node 的管道式 stdio 在 DSH 受限沙箱里会 `EPERM`；Rust 的匿名管道可用，所以客户端用 Rust 是合适的。
5. **winget 安装 VS 会被后台任务回收**：必须把安装程序脱离会话树独立提权运行（见 `tools/install-msvc.ps1`）。
6. **pi 的发现顺序**：显式路径 → `PI_EXECUTABLE` → `%USERPROFILE%\.pi\agent\bin\pi-launcher.js`（经 node 启动，跟随 `install/current-version`）→ PATH 上的 `pi.exe` → `pi.cmd` → npm 全局。走 launcher 可自动跟随 pi 升级，不要硬编码版本目录。
7. **会话目录名是有损编码**：pi 把 `/`、`\`、`:` 都换成 `-`，无法反解回路径。界面的项目分组一律用会话头里的 `cwd`，只在缺失时把目录名当标签显示（见 `sessions.rs` 的注释与测试）。
8. **vite 要绑 127.0.0.1 而不是 localhost**：这台机器上 `localhost` 先解析到 IPv6 (`::1`)，而 Tauri 探测的是 `127.0.0.1`，只绑 localhost 会让 `tauri dev` 一直等不到 dev server。
9. **npm/npx 是 .cmd**：父进程不是控制台宿主时必须经 `cmd.exe` 调用，否则报「%1 不是有效的 Win32 应用程序」。`dev.ps1` 的 `Invoke-Npm` 处理了这点。
10. **端口 1420 会被残留 vite 占用**：`tauri dev` 会因此起不来；先 `Get-NetTCPConnection -LocalPort 1420` 找到占用进程并结束。
11. **`GIT_CONFIG_PARAMETERS` 必须带引号**：写成 `color.ui=false` 会让 git 报 `bogus format` 并中止所有命令；正确形式是 `'color.ui=false'`。
12. **porcelain v2 的字段数是 9 段**：`1 <XY> <sub> <mH> <mI> <mW> <hH> <path>`，其中三个 mode 列加两个对象 id 共 5 个，rename（`2`）再多一个 score 字段。用 `splitn` 只切固定前缀，剩下的整段当 path，这样路径里带空格也不会被切碎。

## 交付物

```powershell
# 打包（NSIS + MSI）
pwsh -File tools\bundle.ps1
```

产物位于 `%LOCALAPPDATA%\pi-workbench-target-msvc\release\bundle\`（可通过 `CARGO_TARGET_DIR` 覆盖）：

- `nsis/Pi Workbench_0.1.1_x64-setup.exe`
- `msi/Pi Workbench_0.1.1_x64_en-US.msi`

安装后可从命令行或开始菜单启动，支持 `pi-workbench <目录>` 与 `pi-workbench --session <文件>`。

## 明确不做（本版范围外）

插件 / live view 系统、内置 agent 逻辑、macOS / Linux 打包、自动更新、PTY 终端。

## 已知限制

- pi 的 `ctx.ui` 中 `custom()`、`setFooter` 等终端专属能力在 RPC 模式下不可用，界面显示「终端专属」提示而非功能
- 会话树的「移动到某个 leaf」pi 的 RPC 未提供命令，当前只读 + fork/clone
- 未做 pi 版本的功能矩阵测试，仅做主/次版本号提示
- 停止时只能恢复排队文字；`clear_queue` 不返回排队图片附件，图片需重新添加

## 参考

- [pi RPC 模式](https://pi.dev/docs/latest/rpc)、[RPC 命令](https://pi.dev/docs/latest/rpc-commands)、[JSON 事件流](https://pi.dev/docs/latest/json)、[扩展 UI](https://pi.dev/docs/latest/rpc-extension-ui)
- 本机同版本文档：`~/.pi/agent/install/releases/1.6.0/node_modules/@earendil-works/pi-coding-agent/docs/`
- [pi-gpui（Rust + GPUI 的同类实现，macOS/Linux）](https://github.com/bytesbay/pi-gpui)
- [Tauri 2 前置依赖](https://v2.tauri.app/start/prerequisites/)
