# 0.1.1 可靠性修复

## 行为

注册表不在 I/O 等待期间持锁；会话内变更使用单独操作锁，停止和扩展 UI 回复可以直接进入。会话文件归属变更串行协调，重复打开聚焦已有标签。分叉和克隆保留原标签，新标签独立持有新文件。

分叉过程中 pi 会先切到新文件，工作台随后恢复原文件并核对。切回失败时重建原标签的进程，事件代次用于忽略旧进程迟到消息。任何分叉请求报错也先恢复原会话。pi 延迟保存的空分支会用官方返回的 entries 和 v3 会话头保存，避免切回时丢失它。

扩展回复的 requestId 使用 camelCase，确认值为布尔值；Rust 与前端共享 `fixtures/contracts/ui-replies.json`。通知不再堆入对话框，超时对话自动移除，回复失败可重试。

图片传至官方 RPC 的 images 字段，支持纯图片、图文混合、粘贴和拖放。限制为 PNG/JPEG/WebP/GIF，10 MiB/张、20 MiB/次、最多 32 张。模型不支持或发送失败时保留草稿，各标签草稿独立。

断连立即失败化等待请求；连接关闭与真正退出分开判断。关闭操作幂等，最多等待 5 秒后杀树，再核对进程退出。关闭失败保留注册表记录，避免误认为文件已无写入者。删除运行中会话被拒绝。

JSONL 按固定块读取并在复制前限长，超限后扫描至换行恢复。Git 按记录类型解析完整路径。会话索引按修改时间和大小缓存，索引/文件/Git 操作使用后台阻塞任务。累计 token 与当前上下文用量分别取值。

## 验证

- `cargo test --workspace --locked`：81 项通过，2 项 opt-in 默认忽略。
- `cargo fmt --all --check` 与 `cargo clippy --workspace --all-targets --locked -- -D warnings`：通过。
- `npm test`：14 项通过；`npm run typecheck`、`npm run build`、`npm run format:check`：通过。
- 对本机 pi 1.5.2 的本地协议测试：1 项通过；合成会话的恢复、克隆、普通分叉、首条消息之前的空分叉均通过，没有模型请求。

本地协议测试需要设置 `PI_LOCAL_TEST_EXECUTABLE` 为安装的 pi `dist/cli.js`，`PI_CODING_AGENT_DIR` 为独立目录，并在该目录创建 `allow-local-test` 标记，然后运行：

```powershell
cargo test -p pi-workbench --test local_pi -- --ignored --nocapture
```

默认测试会启动本地 Node mock 子进程。Windows 进程回收测试应在正常本机进程环境运行；某些受限沙箱不允许终止其代理启动的子进程。测试目录可通过 LOCALAPPDATA/TEMP 指向独立位置。

窗口验证使用单独应用标识、设置目录及 mock pi。已验证文字输入、发送、流式显示、停止后显示 aborted、新建标签、切回原标签、会话树面板及正常关闭；关闭后两个 mock 子进程均退出。真实模型网络冒烟保留为 opt-in，已改为将真实事件交给 run_pump，但本次未运行。

## 兼容与交付

版本统一为 0.1.1，保留官方 pi v3 会话文件格式和原设置默认值。`PI_WORKBENCH_DATA_DIR` 可覆盖工作台设置目录；`PI_CODING_AGENT_DIR` 也用于会话索引定位，便于隔离验证。

默认构建目标仍在 LOCALAPPDATA 的普通完整性目录，可用 CARGO_TARGET_DIR 覆盖。构建脚本从自身位置定位项目，构建失败返回失败状态。Windows 清单统一由链接器嵌入，避免测试缺少公共控件声明或重复资源。

本轮不替换现有安装版，不上传远端仓库。唯一写入者约束覆盖本工作台内的标签；其他程序直接打开相同会话文件不受此注册表协调。
