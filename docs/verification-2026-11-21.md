# Pi Workbench 细节优化与 Pi 1.6.0 验证记录（2026-11-21）

## 范围与边界

- 基于当前工作树的本地未提交版本继续迭代，不覆盖既有功能改动，不提交、不推送、不 bump 应用版本。
- 使用当前完整 Tauri 应用做实机审查，不以浏览器-only 页面或旧安装包代替。
- 隔离 GUI 验证使用 mock Pi 和独立 `PI_WORKBENCH_DATA_DIR`；真实协议与模型验证使用明确的 Pi 1.6.0 路径，不读取或复制 `auth.json`。
- 不全局更新 Pi、不改变显式路径 → `PI_EXECUTABLE` → managed → bundled → PATH 的发现顺序，不覆盖正式安装。

## 本轮修正

- 欢迎页首条消息直接发送到实际打开的 session id；打开失败保留输入，发送失败同时保留到新会话草稿。
- reveal 请求由 App 显式保存，文件树、改动、工具/Markdown 路径在 dock 关闭或 Preview 未挂载时仍能打开；同一路径可重复加载。
- 通知按实际 `sessionId + generation` 和 `agent_settled` 分派，区分完成、停止、失败，不再从活动标签的 busy 边沿推断。
- 关闭活动标签选择相邻标签，最后一个关闭后才显示欢迎页。
- 无会话时不再打开永久加载的命令面板；命令加载/运行失败可见，运行失败不会直接关闭面板。
- Toast 使用堆叠容器和辅助语义；断开进程禁用模型选择；欢迎页增加设置入口。
- 文件树首层改为按需读取，避免家目录递归预读导致权限错误；仅在用户目录根节点隐藏点开头配置项和 NTUSER 系统项，项目内点文件不受影响。
- 长工具参数限制在徽章内部省略，不再撑宽整个转录区。

## 自动化

- 86 项 Rust 测试通过，2 项 opt-in 测试在默认套件中保持忽略。
- 63 项前端测试通过，其中本轮新增 11 项，覆盖欢迎发送/失败、预览挂载顺序、后台通知结果、标签邻居、命令错误、断开模型选择和 toast。
- TypeScript、前端生产构建、`cargo build`、`cargo fmt --check`、严格 Clippy 通过。
- 本轮实际修改的前端文件已执行 Prettier；仓库其他历史格式警告未借机批量改写。
- GPT-6.2 fixture 验证 `off/minimal` 不出现在支持档位中，仍使用数据驱动逻辑，没有模型 ID 特例。

## Pi 1.6.0 vendoring 与真实协议

- 官方最新正式版：Pi 1.6.0（2026-11-20）。
- `tools/vendor-pi.ps1` 默认 pin 1.6.0 和 npm registry SHA-512 完整性：
  `sha512-zX1BVEsshx7A2MRuQ6jfr3RJGWw4Wn+vLq5ZfmlvS1RskhRmByaSZVXH/zcwRrWHO7qPgs98pNCbPOEti/t0fQ==`。
- 使用 `--ignore-scripts`；依次验证 tarball SHA-512、manifest 版本和自包含 `cli.js --version`；许可证从对应版本标签刷新。
- 连续两次从干净临时目录成功生成同版本约 9.6 MB 的 vendor 目录，证明可重复执行。
- Pi 1.5.2 与 1.6.0 的 manifest 均要求 Node `>=22.19.0`；本轮没有新增运行时门槛，也没有把 Node 内嵌进安装包。
- 使用 bundled 1.6.0 和带 `allow-local-test` 标记的隔离 `PI_CODING_AGENT_DIR`，真实 opt-in 测试 `installed_pi_restores_clones_and_forks_without_model_requests` 通过；覆盖恢复、克隆、分叉和空分支，不调用模型。

## 真实模型 smoke

- 命令明确使用 `apps/desktop/src-tauri/vendor-pi/package/dist/bundle/cli.js`，并采用 `--no-session`。
- 实际模型：`magpie/opencode-go/deepseek-v4.1-flash`，thinking `high`。
- 约 3.02 秒收到首个文本增量，约 3.14 秒正常 `agent_settled(aborted=false)`；返回预期 `PI_WORKBENCH_OK_20261121`，未使用工具，stderr 为 0 行。
- 该结果证明当前 provider 与 bundled 1.6.0 的 RPC 链路可用，不代表所有 provider 均已逐一验证。

## 真实 Windows / WebView 验证

- 修复前确认：欢迎页 Ctrl+K 永久显示“正在加载命令…”；家目录文件树报 `拒绝访问 (os error 5)`；960×600 下长工具参数令转录区 `scrollWidth=488`、`clientWidth=370`。
- 修复后，欢迎页输入实际发送到 mock Pi 并显示用户消息；不再出现旧闭包导致的无操作。
- 家目录文件树不再报权限错误；根节点从实测 116 个杂项降为 52 个正常目录/文件，点开头配置项和 NTUSER 项不再出现。
- 关闭 dock 后发送 reveal，实际打开 `preview-proof.txt` 并显示预期内容，Preview 标签自动选中。
- 两个标签时关闭活动标签会选择剩余标签；最后一个关闭后才回欢迎页。
- 欢迎页 Ctrl+K 不创建空面板；设置对话框在 960×600 下完整可用，无横向溢出。
- 同一段真实长工具转录复测为 `scrollWidth=370`、`clientWidth=370`；长参数仅在徽章内部截断。
- 截图：`C:\Users\LuoFeng\pi-workbench-test\ux-audit-20261121\`。
- Windows 系统通知权限、原生通知展示与点击行为本轮未做系统级实测；分派逻辑由前端测试覆盖，不把该项写成已验收。
- CDP 交互不等同于人工使用某种中文输入法；本轮未重新进行人工 IME 验收。

## 发布包

- 前端生产构建和 Rust release 构建通过，release 编译约 3m01s；NSIS 与 MSI 均成功产出。
- 使用 `msiexec /a` 将 MSI 管理展开到全新的 `C:\Users\LuoFeng\pi-workbench-test\msi-admin-20261121`，退出码为 0，没有执行正式安装。
- 展开资源的 Pi manifest 为 1.6.0，直接执行包内 `cli.js --version` 也返回 1.6.0；包内 CLI 与源码 vendored CLI 的 SHA-256 一致。

| 产物 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `nsis/Pi Workbench_0.1.0_x64-setup.exe` | 3,836,644 | `5564AEBE0496A48F4499EB88267AD800580D0790E626166BC89135A7DA9D9DBC` |
| `msi/Pi Workbench_0.1.0_x64_en-US.msi` | 5,427,200 | `92C6D24F72C337ED32828A0381EF4C70CBE3E2AFC074565443B5EDD2EF5E17C5` |

- 从展开目录启动生产应用，显式使用包内 Pi、隔离 `PI_CODING_AGENT_DIR` 和 `PI_WORKBENCH_DATA_DIR`。页面来源为 `http://tauri.localhost/`，确认不是 dev server。
- 包内 Pi 1.6.0 成功打开含中文和空格的项目目录并建立真实 RPC 会话；文件树显示 9 个测试文件，无错误提示，全程未调用模型。
- 关闭 dock 后 reveal `preview-proof.txt`，生产应用自动选择 Preview 并显示预期文本。
- 实际弹出属于生产进程的 native `#32770` 目录选择器；取消后“选择中…”状态正常复位，证明打包后的 dialog capability 可用。
- 生产截图：`C:\Users\LuoFeng\pi-workbench-test\ux-audit-20261121\packaged-1.6.0-smoke.png`。验证应用已关闭。
- 本项是 MSI 管理展开后的隔离 smoke，不是完整安装器交互、所有 provider 或全部 Windows 系统通知的验收。
