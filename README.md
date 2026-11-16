# pi Workbench

用 Rust + Tauri 2 给 [pi coding agent](https://github.com/earendil-works/pi) 写一个桌面工作台（Windows 优先）。

本项目**不重写 agent**：界面通过 pi 官方 RPC 模式驱动本机已安装的 `pi`，模型、扩展、技能、登录态、会话文件全部复用终端里的那一套。

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

## 当前状态：M0 – M4 全部完成

已验证（本机 pi 1.5.2 + 默认模型 `magpie/codex/gpt-6.1-sol`）：

| 能力 | 结果 |
|---|---|
| 发现并启动 pi（managed install） | ✅ `~/.pi/agent/bin/pi-launcher.js`，跟随 `install/current-version` |
| `get_state` 握手 | ✅ sessionId / model / thinkingLevel |
| `prompt` 流式回复 | ✅ 首 token 约 4–8s，事件按 JSONL 增量到达 |
| 多轮 + 工具调用 | ✅ `read` 工具：`tool_execution_start/end` 正确解析 |
| `agent_settled` 结束判定 | ✅ |
| MSVC 工具链 + Tauri 2 全依赖编译 | ✅ VS BuildTools 2022 + Win11 SDK 26100 |
| 前端类型检查 / 生产构建 | ✅ `tsc --noEmit` 干净，vite 构建 254KB（gzip 79KB） |
| 桌面应用启动 | ✅ 31MB RSS，23 线程 |
| Release 打包 | ✅ NSIS 2.24MB / MSI 3.32MB，单实例已验证 |
| 单元测试 | ✅ 44 个单测 + 1 个文档测试，`clippy`/`fmt` 零警告 |
| 对真实 pi 的集成冒烟 | ✅ 走完整 pump 批处理路径 |
| 进程回收 | ✅ 关闭时先关 stdin，超时后 `taskkill /T /F` 杀整棵树 |

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
  docs/protocol-notes.md      pi 1.5.2 RPC 协议笔记
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

- **侧栏**：项目分组（按 pi 会话文件扫描）、会话预览、搜索、「打开项目」输入目录
- **多标签**：每个标签一个独立 pi 进程，运行状态点
- **转录区**：流式 Markdown（代码块/列表/引用/行内代码）、思考块折叠、工具卡片（bash/read/edit 专用摘要）、压缩横幅、重试/错误提示
- **工具栏**：模型下拉（按 provider 分组）、思考档位、上下文用量环、累计费用、刷新/压缩/重命名/导出
- **输入框**：Enter 发送 / Shift+Enter 换行（正确处理中文输入法）、Esc 中断、运行中自动切为「追加指令」(steer)、图片粘贴与拖拽
- **扩展对话框**：`select` / `confirm` / `input` / `editor` 内联渲染并回包
- **错误提示**：toast + 会话标签记录 lastError

## M2 工作台功能

- **标签右键菜单**：重命名 / 从某条消息分叉 / 克隆为新会话 / 压缩 / 导出 HTML / 删除会话文件（优先走回收站）
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

- **应用图标**：`tools/make-icons.py` 用 Pillow 绘制（深色圆角方 + π 字形，4 倍超采样后缩小），产出 Tauri 与 Windows Store 需要的全部尺寸，含多尺寸 `.ico` 与 `.icns`
- **单实例**：`tauri-plugin-single-instance`；第二次启动自动退出并把参数转交给已运行的实例，同时 `show` + `unminimize` + `set_focus` 把窗口带到前台
- **命令行参数**：
  ```text
  pi-workbench                      恢复上次的会话
  pi-workbench E:\project           在该目录开新会话
  pi-workbench --session <file>     恢复指定会话文件
  ```
  未知参数被忽略，`--help` / `--version` 不触发打开行为
- **启动恢复**：`%APPDATA%\pi-workbench\settings.json` 记录 `last_project` 与 `open_sessions`；启动时优先命令行意图，否则重开上次的会话。关闭标签会同步移除记录
- **pi 版本兼容**：解析 `pi --version`，与测试版本 `1.5.x` 比较；主版本不同或次版本更新时在顶部横幅提示
- **打包**：`tools\bundle.ps1` 产出 NSIS（当前用户安装，含简体中文）与 MSI

## 关键设计

- **一个打开的会话 = 一个 pi 进程**，会话之间互不阻塞；关闭标签即回收进程树。
- **阻塞 IO + 线程**，不引入 async 运行时：写线程管 stdin，读线程管 stdout，stderr 线程留诊断尾巴，等待线程收尸。
- **事件批处理在 pi-rpc 里**（`pump.rs`）：16ms 窗口、上限 64 条，UI 侧每帧最多一次更新；这部分可单测，不依赖 Tauri。
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
   - `tools/dev.ps1` 的 `Invoke-BuildEnvironment` 会调 `vcvars64.bat` 把 `link.exe` 加进 PATH
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

产物位于 `%LOCALAPPDATA%\pi-workbench-target-msvc\release\bundle\`：

| 安装包 | 大小 |
|---|---|
| `nsis\Pi Workbench_0.1.0_x64-setup.exe` | 2.24 MB |
| `msi\Pi Workbench_0.1.0_x64_en-US.msi` | 3.32 MB |

Release 运行时约 27MB 内存。安装后可从命令行或开始菜单启动，支持 `pi-workbench <目录>` 与 `pi-workbench --session <文件>`。

## 明确不做（本版范围外）

插件 / live view 系统、内置 agent 逻辑、macOS / Linux 打包、自动更新、PTY 终端。

## 已知限制

- pi 的 `ctx.ui` 中 `custom()`、`setFooter` 等终端专属能力在 RPC 模式下不可用，界面显示「终端专属」提示而非功能
- 会话树的「移动到某个 leaf」pi 的 RPC 未提供命令，当前只读 + fork/clone
- 未做 pi 版本的功能矩阵测试，仅做主/次版本号提示

## 参考

- [pi RPC 模式](https://pi.dev/docs/latest/rpc)、[RPC 命令](https://pi.dev/docs/latest/rpc-commands)、[JSON 事件流](https://pi.dev/docs/latest/json)、[扩展 UI](https://pi.dev/docs/latest/rpc-extension-ui)
- 本机同版本文档：`~/.pi/agent/install/releases/1.5.2/node_modules/@earendil-works/pi-coding-agent/docs/`
- [pi-gpui（Rust + GPUI 的同类实现，macOS/Linux）](https://github.com/bytesbay/pi-gpui)
- [Tauri 2 前置依赖](https://v2.tauri.app/start/prerequisites/)
