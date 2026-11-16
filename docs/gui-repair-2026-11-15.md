# GUI 白屏与 Windows 图标修复

## 复现与原因

安装版启动后，React 根节点为空。`%APPDATA%\pi-workbench\debug.log`
记录了 `Cannot read properties of undefined (reading 'filter')`。

Rust 设置接口返回 `openSessions` 等 camelCase 字段，但前端按
`open_sessions` 读取并调用 `.filter()`。运行中会话和历史目录接口则反过来：
前端要求 `projectDir`、`sessionPath`、`messageCount`、`modifiedAt`，
Rust 当时返回 snake_case。

另外，`agent_start` 被事件泵单独包装成 `{kind, type}`，其他 Pi 事件和
前端要求的格式都是 `{kind, event}`。即使绕过启动白屏，第一次发送也可能崩溃。

## 修改

- 对齐设置、会话信息与历史目录的字段名，等待项目目录加载完成后恢复历史。
- 统一 Pi 事件封装；修复异步监听器在 StrictMode 和重新挂载时的清理。
- 避免用户消息在本地预显示和 Pi 回传时重复显示；运行状态持续到 `agent_settled`。
- 设置写入移出 React 状态更新函数，串行写入，避免同时操作同一个临时文件。
- 修复对话区域与右侧面板的布局；滚动只作用于对话容器。
- 实际应用主题、字号、字体；一轮对话结束后刷新历史目录。
- 保留原来的深色圆角底、蓝色 π 图案。ICO 生成改用最大图片作为基准，
  修复原文件只有 16×16 一帧的问题；新文件包含 16、24、32、48、64、128、256 七档。
- 构建脚本显式追踪 `icons` 目录，避免 Windows 的 `resource.lib` 缓存继续嵌入旧图标。

## 验证

- TypeScript 检查与 Vite 生产构建通过。
- `cargo test --workspace`：59 项通过（含文档测试）；1 项需网络的测试默认忽略。
- `cargo clippy --workspace --all-targets -- -D warnings` 通过。
- 修改过的 Rust 文件通过对应 edition 的 rustfmt 检查。
- 在真实 Tauri WebView 和本机 Pi 1.5.2 中完成普通回复及 `read README.md`
  两轮验证：用户消息不重复，工具卡片正常，增量文字正常，运行结束回到空闲。
- 第二轮捕获到一次 `agent_start`、七次 `text_delta`、一次 `agent_settled`；
  未捕获到 JavaScript 运行时异常。
- 在设置界面切换亮色、暗色，验证背景即时变化；保留原来的暗色主题和 17px 字号。
- 用 Pillow 重新读取 ICO，确认七档尺寸真实存在。
- 直接读取最终安装版 EXE 的 Windows `RT_GROUP_ICON`（32512），确认可执行文件
  内同样嵌入了七档图标，避免只验证源 ICO 而漏掉构建缓存。
- 安装版关闭重启后，恢复两轮对话、`read` 工具卡片、暗色主题与 17px 字号；
  另打开了修复前已有的 `Say hello in one short sentence.` 会话，确认历史正文可读。
- NSIS 与 MSI 安装包均已生成；本机通过 NSIS 更新，并从桌面快捷方式正常启动。

原始源码、旧程序、原快捷方式和设置已备份到：

`C:\Users\LuoFeng\AppData\Local\Temp\opencode\pi-workbench-repair-20261115`

该目录还包含界面验证脚本、截图和文本差异 `changes.patch`。
