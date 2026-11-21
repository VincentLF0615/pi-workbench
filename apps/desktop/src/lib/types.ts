/// <reference types="vite/client" />

/** pi session state, as returned by the `get_state` command. */
export interface PiModel {
  id: string;
  name?: string;
  provider: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  supportedThinkingLevels?: string[];
  [key: string]: unknown;
}

export interface PiState {
  model?: PiModel | null;
  thinkingLevel?: string;
  isStreaming?: boolean;
  isCompacting?: boolean;
  steeringMode?: string;
  followUpMode?: string;
  sessionFile?: string;
  sessionId?: string;
  sessionName?: string;
  autoCompactionEnabled?: boolean;
  messageCount?: number;
  pendingMessageCount?: number;
}

/** Authoritative queued text from `queue_update` / `clear_queue`. */
export interface PiQueues {
  steering: string[];
  followUp: string[];
}

/** Queue text is recovered even when the subsequent abort fails. */
export interface AbortResult extends PiQueues {
  abortError?: string | null;
}

export interface PiUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning?: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

/** Token and cost totals, as reported by `get_session_stats`. */
export interface PiTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  totalTokens?: number;
}

/** Content blocks of an assistant message. */
export interface TextBlock {
  type: "text";
  text: string;
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
}

export interface ToolCallBlock {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type AssistantBlock = TextBlock | ThinkingBlock | ToolCallBlock;

export interface AssistantMessage {
  role: "assistant";
  content: AssistantBlock[];
  provider?: string;
  model?: string;
  thinkingLevel?: string;
  usage?: PiUsage;
  stopReason?: string;
  errorMessage?: string;
  timestamp?: number;
}

export interface UserMessage {
  role: "user";
  content: string | { type: string; text?: string }[];
  timestamp?: number;
}

export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: { type: string; text?: string }[];
  details?: unknown;
  isError: boolean;
  timestamp?: number;
}

export interface BashExecutionMessage {
  role: "bashExecution";
  command: string;
  output: string;
  exitCode?: number | null;
  cancelled?: boolean;
  truncated?: boolean;
}

export interface CompactionSummaryMessage {
  role: "compactionSummary";
  summary: string;
  tokensBefore?: number;
}

export interface BranchSummaryMessage {
  role: "branchSummary";
  summary: string;
}

export type PiMessage =
  | UserMessage
  | AssistantMessage
  | ToolResultMessage
  | BashExecutionMessage
  | CompactionSummaryMessage
  | BranchSummaryMessage;

/** The nested provider event inside `message_update`. */
export interface AssistantMessageEvent {
  type: string;
  contentIndex?: number;
  delta?: string;
  content?: string;
  id?: string;
  toolName?: string;
  toolCall?: Record<string, unknown>;
  [key: string]: unknown;
}

/** One event from the `pi://event` channel. */
export type PiEnvelope =
  | { kind: "pi"; event: PiEvent }
  | { kind: "ui"; event: UiRequest }
  | { kind: "exited"; code: number | null }
  | { kind: "protocolError"; message: string };

export interface PiBatch {
  sessionId: string;
  generation: number;
  events: PiEnvelope[];
}

/**
 * Session events, typed per pi's `docs/json.md`.
 *
 * The union is intentionally closed: an event pi adds later matches no case
 * and falls through to the reducer's default branch, which ignores it. That
 * keeps additive protocol changes from breaking the build while still letting
 * TypeScript narrow correctly inside the switch.
 */
export type PiEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: PiMessage[]; willRetry: boolean }
  | { type: "agent_settled"; aborted: boolean }
  | { type: "turn_start" }
  | { type: "turn_end"; message: PiMessage; toolResults: PiMessage[] }
  | { type: "message_start"; message: PiMessage }
  | {
      type: "message_update";
      usage: PiUsage;
      assistantMessageEvent: AssistantMessageEvent;
    }
  | { type: "message_end"; message: PiMessage }
  | {
      type: "tool_execution_start";
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
    }
  | {
      type: "tool_execution_update";
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
      partialResult: unknown;
    }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
      result: unknown;
      isError: boolean;
      durationMs?: number;
    }
  | { type: "queue_update"; steering: string[]; followUp: string[] }
  | { type: "entry_appended"; entry: unknown }
  | { type: "session_info_changed"; name?: string | null }
  | { type: "thinking_level_changed"; level: string }
  | { type: "compaction_start"; reason: string }
  | {
      type: "compaction_end";
      reason: string;
      result?: unknown;
      aborted: boolean;
      willRetry: boolean;
      errorMessage?: string;
    }
  | {
      type: "auto_retry_start";
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      errorMessage: string;
    }
  | {
      type: "auto_retry_end";
      success: boolean;
      attempt: number;
      finalError?: string;
    }
  | {
      type: "summarization_retry_scheduled";
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      errorMessage: string;
    }
  | {
      type: "summarization_retry_attempt_start";
      source: string;
      reason?: string;
    }
  | { type: "summarization_retry_finished" }
  | { type: "bash_execution_update"; id?: string; delta: string }
  | {
      type: "extension_error";
      extensionPath: string;
      event: string;
      error: string;
    };

/** Extension UI request (`select`, `confirm`, `input`, `editor`, ...). */
export interface UiRequest {
  id: string;
  method: string;
  title?: string;
  message?: string;
  options: string[];
  placeholder?: string;
  prefill?: string;
  timeout?: number;
  notifyType?: "info" | "warning" | "error" | string;
  statusKey?: string;
  statusText?: string;
  widgetKey?: string;
  widgetLines?: string[];
  widgetPlacement?: "aboveEditor" | "belowEditor" | string;
  text?: string;
  expiresAt?: number;
  [key: string]: unknown;
}

/** Answer to an extension dialog. */
export type UiReply =
  | { kind: "value"; requestId: string; value: string }
  | { kind: "confirmed"; requestId: string; value: boolean }
  | { kind: "cancelled"; requestId: string };

/** A session file on disk, from `list_projects`. */
export interface SessionFileInfo {
  path: string;
  id: string;
  cwd?: string;
  preview: string;
  messageCount: number;
  modifiedAt: number;
}

export interface ProjectGroupInfo {
  cwd: string;
  sessions: SessionFileInfo[];
}

/** A session running in this app. */
export interface SessionInfo {
  id: string;
  label: string;
  projectDir: string;
  sessionPath?: string;
  pid: number;
  generation: number;
  launchSource: string;
  closed: boolean;
  lastError?: string;
}

export interface PiInstall {
  found: boolean;
  source?: string;
  executable?: string;
  version?: string;
  error?: string;
}

export interface SessionStats {
  sessionFile?: string;
  sessionId?: string;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  totalMessages: number;
  tokens: PiTokens;
  cost: number;
  contextUsage?: {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
  };
}

/** One rendered transcript item, produced by the frontend's reducer. */
export type TranscriptItem =
  | { kind: "user"; id: string; text: string; images: number }
  | {
      kind: "assistant";
      id: string;
      blocks: AssistantBlock[];
      usage?: PiUsage;
      stopReason?: string;
      errorMessage?: string;
      streaming: boolean;
    }
  | {
      kind: "tool";
      id: string;
      toolCallId: string;
      name: string;
      args: Record<string, unknown>;
      state: "running" | "ok" | "error";
      partial?: string;
      resultText?: string;
      isError: boolean;
      durationMs?: number;
    }
  | {
      kind: "bash";
      id: string;
      command: string;
      output: string;
      exitCode?: number | null;
    }
  | {
      kind: "compaction";
      id: string;
      summary: string;
      tokensBefore?: number;
      reason: string;
    }
  | {
      /** Files touched by edit/write tools in one finished turn. */
      kind: "changedFiles";
      id: string;
      paths: string[];
    }
  | { kind: "info"; id: string; text: string; tone: "info" | "warn" | "error" };

/** Text content of any message, or of a tool result payload. */
export function textOfContent(
  content: string | { type?: string; text?: string }[] | undefined | null,
): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      block && typeof block === "object" ? (block.text ?? "") : "",
    )
    .filter(Boolean)
    .join("\n");
}

/** Text of a pi message, for roles that carry text. */
export function messageText(message: PiMessage): string {
  if (message.role === "bashExecution") return message.output;
  if (
    message.role === "compactionSummary" ||
    message.role === "branchSummary"
  ) {
    return message.summary;
  }
  return textOfContent(message.content);
}

/** Text of a tool result payload (`{content: [...]}`). */
export function toolResultText(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  return textOfContent((result as { content?: unknown }).content as never);
}

/** A node in the session tree returned by `get_tree`. */
export interface SessionTreeNode {
  entry: SessionEntry;
  children: SessionTreeNode[];
  label?: string;
  labelTimestamp?: string;
}

/** One persisted session entry. */
export interface SessionEntry {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  [key: string]: unknown;
}

/** A slash command pi exposes: extension, prompt template or skill. */
export interface SlashCommand {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill" | string;
  sourceInfo?: {
    path?: string;
    source?: string;
    scope?: string;
    origin?: string;
  };
}

/** The app's own settings (never pi's). */
export interface Settings {
  theme: "system" | "light" | "dark";
  fontSize: number;
  fontFamily: string;
  sidebarWidth: number;
  lastProject: string | null;
  openSessions: string[];
  expandTools: boolean;
  logLevel: string;
  minimizeToTray: boolean;
}

/** One entry from `git status`. */
export interface GitFile {
  path: string;
  status: string;
  sub_status?: string | null;
  old_path?: string | null;
}

/** A project's git summary. */
export interface GitStatus {
  is_repo: boolean;
  branch: string | null;
  files: GitFile[];
  error: string | null;
}

/** One node of the file tree. */
export interface FileNode {
  name: string;
  path: string;
  is_dir: boolean;
  children?: FileNode[] | null;
}

/** A text file's contents, possibly truncated. */
export interface TextFile {
  path: string;
  text: string;
  truncated: boolean;
  total_bytes: number;
}

/** What this launch was asked to open. */
export interface StartupIntent {
  project_dir: string | null;
  session_path: string | null;
}

export interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}
export interface Draft {
  text: string;
  images: ImageContent[];
}
export interface SessionSnapshot {
  info: SessionInfo;
  state: PiState;
  messages: PiMessage[];
  stats: SessionStats;
}
export interface BranchResult {
  cancelled: boolean;
  original: SessionSnapshot;
  branch?: SessionSnapshot | null;
  selectedText?: string | null;
}
