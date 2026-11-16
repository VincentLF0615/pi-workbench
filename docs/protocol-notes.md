# pi RPC 协议笔记（pi 1.5.2）

本文件记录实现 `pi-rpc` 时核对过的协议事实，供后续 UI 层参考。权威文档在
`~/.pi/agent/install/releases/<version>/node_modules/@earendil-works/pi-coding-agent/docs/`。

## 启动

```text
node <agent>/bin/pi-launcher.js --mode rpc [--no-session] [--session <path>]
     [--provider <p>] [--model <m>] [--thinking <level>]
```

- launcher 读取 `install/current-version` 后 `spawnSync(node, cliPath, ...)`，stdio 继承，因此从 Rust 直接 spawn 也能穿透。
- 托管安装：`%USERPROFILE%\.pi\agent\bin\pi-launcher.js`；版本目录 `~/.pi/agent/install/releases/1.5.2/`。
- 会话文件：`~/.pi/agent/sessions/--<path>--/<timestamp>_<id>.jsonl`，首行是 `{"type":"session","version":3,...}`，之后是 `id`/`parentId` 树。

## 分帧

- 每条记录一行 JSON，LF 结尾；允许 CRLF（去掉一个 `\r`）。
- 只在 `\n` 处切分；`U+2028/U+2029` 在 JSON 字符串里合法，不能当分隔符。
- stdout 只放协议；stderr 是日志，不能解析。
- 读端必须持续消费，否则反压卡住 pi。

## 记录族

| 来源 | type | 说明 |
|---|---|---|
| stdout | `response` | `{id?, command, success, data?, error?}`；无 id 表示 parse 错误 |
| stdout | 会话事件 | 见下，通常无 id |
| 双向 | `extension_ui_request` / `extension_ui_response` | 扩展对话框与通知 |

## 命令（1.5.2，共 33 个）

prompt / steer / follow_up / abort / clear_queue / new_session / get_state /
get_messages / set_model / cycle_model / get_available_models /
set_thinking_level / cycle_thinking_level / get_available_thinking_levels /
set_steering_mode / set_follow_up_mode / compact / set_auto_compaction /
set_auto_retry / abort_retry / bash / abort_bash / get_session_stats /
export_html / switch_session / fork / clone / get_fork_messages / get_entries /
get_tree / get_last_assistant_text / set_session_name / get_commands

要点：

- `prompt` 的 `success` 只代表「接受/排队/处理」，完成看 `agent_settled`；`data.disposition` 为 `started|queued|handled`。
- 流式期间再发消息必须带 `streamingBehavior: "steer" | "followUp"`，否则报错。
- `get_entries` 支持 `since` 游标（entry id 持久），返回 `leafId`，适合增量恢复。
- `get_tree` 返回 `{tree, leafId}`；1.5.2 的 RPC **没有**「移动 leaf」命令，树导航只能靠 `fork`/`clone`，或自己带一个 bridge 扩展。
- `compact` 可能耗时数分钟，客户端超时要单独放宽。

## 事件

生命周期：`agent_start` → `turn_start` → `message_start/update/end` → `turn_end` → `agent_end` → `agent_settled`。

`message_update` 是**纯增量**：

- `assistantMessageEvent.type`：`text_delta` / `thinking_delta` / `toolcall_delta` 追加；
- `text_end` / `thinking_end` / `toolcall_end` 用权威内容覆盖；
- `message_end` 的 `message` 是最终消息，整体替换；
- 顶层 `usage` 是该回复的累计值，可能滞后。

工具：`tool_execution_start`（`toolCallId/toolName/args`）、`tool_execution_update`（`partialResult`）、`tool_execution_end`（`result/isError/durationMs`）。

其它：`queue_update`、`compaction_start/end`、`auto_retry_start/end`、`summarization_retry_*`、`entry_appended`、`session_info_changed`、`thinking_level_changed`、`extension_error`、`bash_execution_update`（RPC 的 `bash` 命令专用）。

## 扩展 UI

- 对话框：`select`（options）、`confirm`（title/message）、`input`（placeholder）、`editor`（prefill）；带 `timeout` 时 pi 侧自动兜底。
- 回复：`{"type":"extension_ui_response","id":...,"value"|"confirmed"|"cancelled"}`，id 必须一致。
- 单向通知：`notify`、`setStatus`、`setWidget`、`setTitle`、`set_editor_text`，**不要回包**。
- RPC 下 `custom()`、`setFooter` 等终端专属能力不可用，UI 需要降级提示。

## 本机观测

- `get_state` 返回 `model`（含 baseUrl/contextWindow/cost）、`thinkingLevel`、`sessionId`、`isStreaming`、`messageCount` 等。
- 首 token 4–8s（取决于模型/网络）；一次两轮工具调用总耗时约 8s（示例会话）。
- 关闭：关 stdin 后 pi 正常退出（退出码 0），无需强杀；强杀用 `taskkill /PID <pid> /T /F`。
