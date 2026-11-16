import { textOfContent, toolResultText } from "./types";
import type {
  AssistantBlock,
  PiEnvelope,
  PiMessage,
  TranscriptItem,
} from "./types";
let itemSeq = 0;
export const nextId = () => `i${++itemSeq}`;
interface ReducerResult {
  items: TranscriptItem[];
  busy: boolean;
}

/** Replace the last matching item, immutably. */
function patchLast(
  items: TranscriptItem[],
  matches: (item: TranscriptItem) => boolean,
  change: (item: TranscriptItem) => TranscriptItem,
): TranscriptItem[] {
  const index = [...items].reverse().findIndex(matches);
  if (index === -1) return items;
  const at = items.length - 1 - index;
  const updated = items.slice();
  updated[at] = change(items[at]);
  return updated;
}

/** Replace the first matching item, immutably. */
function patchFirst(
  items: TranscriptItem[],
  matches: (item: TranscriptItem) => boolean,
  change: (item: TranscriptItem) => TranscriptItem,
): TranscriptItem[] {
  const index = items.findIndex(matches);
  if (index === -1) return items;
  const updated = items.slice();
  updated[index] = change(items[index]);
  return updated;
}

const isStreamingAssistant = (item: TranscriptItem) =>
  item.kind === "assistant" && item.streaming;

const isToolWithId = (toolCallId: string) => (item: TranscriptItem) =>
  item.kind === "tool" && item.toolCallId === toolCallId;

/** Fold a `get_messages` history into transcript items. */
export function fromHistory(messages: PiMessage[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const toolIds = new Map<string, string>();

  for (const message of messages) {
    switch (message.role) {
      case "user": {
        const text = textOfContent(message.content);
        const images = Array.isArray(message.content)
          ? message.content.filter((block) => block.type === "image").length
          : 0;
        if (text.trim() || images)
          items.push({ kind: "user", id: nextId(), text, images });
        break;
      }
      case "assistant": {
        const blocks: AssistantBlock[] = [];
        for (const block of message.content) {
          if (block.type === "text" && block.text.trim()) {
            blocks.push({ type: "text", text: block.text });
          } else if (block.type === "thinking" && block.thinking.trim()) {
            blocks.push({ type: "thinking", thinking: block.thinking });
          } else if (block.type === "toolCall") {
            blocks.push({
              type: "toolCall",
              id: block.id,
              name: block.name,
              arguments: block.arguments,
            });
            const toolId = nextId();
            toolIds.set(block.id, toolId);
            items.push({
              kind: "tool",
              id: toolId,
              toolCallId: block.id,
              name: block.name,
              args: (block.arguments ?? {}) as Record<string, unknown>,
              state: "ok",
              isError: false,
            });
          }
        }
        if (blocks.length > 0) {
          items.push({
            kind: "assistant",
            id: nextId(),
            blocks,
            usage: message.usage,
            stopReason: message.stopReason,
            errorMessage: message.errorMessage,
            streaming: false,
          });
        }
        break;
      }
      case "toolResult": {
        const toolId = toolIds.get(message.toolCallId);
        if (!toolId) break;
        const item = items.find(
          (entry) => entry.id === toolId && entry.kind === "tool",
        );
        if (item && item.kind === "tool") {
          item.resultText = toolResultText(message.content);
          item.isError = message.isError;
          item.state = message.isError ? "error" : "ok";
        }
        break;
      }
      case "bashExecution": {
        items.push({
          kind: "bash",
          id: nextId(),
          command: message.command,
          output: message.output,
          exitCode: message.exitCode,
        });
        break;
      }
      case "compactionSummary": {
        items.push({
          kind: "compaction",
          id: nextId(),
          summary: message.summary,
          tokensBefore: message.tokensBefore,
          reason: "context",
        });
        break;
      }
      case "branchSummary": {
        items.push({
          kind: "info",
          id: nextId(),
          text: message.summary,
          tone: "info",
        });
        break;
      }
      default:
        break;
    }
  }
  return items;
}

/** Apply one protocol event to a transcript. */
export function applyEvent(
  items: TranscriptItem[],
  envelope: PiEnvelope,
  busy: boolean,
): ReducerResult {
  const next = items.slice();

  if (envelope.kind !== "pi") {
    if (envelope.kind === "exited") {
      next.push({
        kind: "info",
        id: nextId(),
        text: `pi 进程已退出（code ${envelope.code ?? "?"}）`,
        tone: "error",
      });
    }
    if (envelope.kind === "protocolError") {
      next.push({
        kind: "info",
        id: nextId(),
        text: envelope.message,
        tone: "warn",
      });
    }
    return { items: next, busy: envelope.kind === "exited" ? false : busy };
  }

  const event = envelope.event;
  switch (event.type) {
    case "agent_start":
      return { items: next, busy: true };

    case "agent_settled":
      return { items: next, busy: false };

    case "message_start": {
      const message = event.message;
      if (message.role === "user") {
        const text = textOfContent(message.content);
        const last = next[next.length - 1];
        // send() already displayed this message while waiting for pi's echo.
        const images = Array.isArray(message.content)
          ? message.content.filter((block) => block.type === "image").length
          : 0;
        if (
          (text.trim() || images) &&
          !(
            last?.kind === "user" &&
            last.text === text &&
            last.images === images
          )
        ) {
          next.push({ kind: "user", id: nextId(), text, images });
        }
      } else if (message.role === "assistant") {
        next.push({
          kind: "assistant",
          id: nextId(),
          blocks: [],
          streaming: true,
        });
      } else if (message.role === "bashExecution") {
        next.push({
          kind: "bash",
          id: nextId(),
          command: message.command,
          output: "",
          exitCode: message.exitCode,
        });
      }
      return { items: next, busy: true };
    }

    case "message_update": {
      const nested = event.assistantMessageEvent;
      if (!nested) return { items: next, busy: true };
      if (nested.type === "toolcall_delta") {
        // Arguments stream as JSON text; the tool card is created by
        // tool_execution_start, which already carries the parsed arguments.
        return { items: next, busy: true };
      }

      const index = nested.contentIndex ?? 0;
      const isDelta = nested.type.endsWith("_delta");
      const blockType =
        nested.type === "text_delta" || nested.type === "text_end"
          ? "text"
          : nested.type === "thinking_delta" || nested.type === "thinking_end"
            ? "thinking"
            : null;

      if (blockType) {
        const delta = isDelta ? (nested.delta ?? "") : (nested.content ?? "");
        const updated = patchLast(next, isStreamingAssistant, (item) => {
          if (item.kind !== "assistant") return item;
          const blocks = item.blocks.slice();
          const existing = blocks[index];
          if (existing && existing.type === blockType) {
            const current =
              blockType === "text"
                ? (existing as Extract<AssistantBlock, { type: "text" }>).text
                : (existing as Extract<AssistantBlock, { type: "thinking" }>)
                    .thinking;
            blocks[index] = {
              ...existing,
              [blockType]: isDelta ? current + delta : delta,
            } as AssistantBlock;
          } else {
            blocks[index] = (
              blockType === "text"
                ? { type: "text", text: delta }
                : { type: "thinking", thinking: delta }
            ) as AssistantBlock;
          }
          return { ...item, blocks };
        });
        return { items: updated, busy: true };
      }

      if (nested.type === "toolcall_start") {
        const updated = patchLast(next, isStreamingAssistant, (item) => {
          if (item.kind !== "assistant") return item;
          const blocks = item.blocks.slice();
          blocks[index] = {
            type: "toolCall",
            id: nested.id ?? nextId(),
            name: nested.toolName ?? "tool",
            arguments: {},
          };
          return { ...item, blocks };
        });
        return { items: updated, busy: true };
      }
      return { items: next, busy: true };
    }

    case "message_end": {
      const message = event.message;
      if (message.role !== "assistant") return { items: next, busy: true };
      const updated = patchLast(next, isStreamingAssistant, (item) => {
        if (item.kind !== "assistant") return item;
        return {
          ...item,
          blocks: message.content.filter(
            (block) =>
              (block.type === "text" && block.text.trim()) ||
              (block.type === "thinking" && block.thinking.trim()) ||
              block.type === "toolCall",
          ) as AssistantBlock[],
          streaming: false,
          usage: message.usage,
          stopReason: message.stopReason,
          errorMessage: message.errorMessage,
        };
      });
      return { items: updated, busy };
    }

    case "tool_execution_start": {
      next.push({
        kind: "tool",
        id: nextId(),
        toolCallId: event.toolCallId,
        name: event.toolName,
        args: (event.args ?? {}) as Record<string, unknown>,
        state: "running",
        isError: false,
      });
      return { items: next, busy: true };
    }

    case "tool_execution_update": {
      const updated = patchFirst(
        next,
        isToolWithId(event.toolCallId),
        (item) => {
          if (item.kind !== "tool") return item;
          return {
            ...item,
            partial: toolResultText(event.partialResult) || item.partial,
          };
        },
      );
      return { items: updated, busy: true };
    }

    case "tool_execution_end": {
      const updated = patchFirst(
        next,
        isToolWithId(event.toolCallId),
        (item) => {
          if (item.kind !== "tool") return item;
          return {
            ...item,
            state: event.isError ? "error" : "ok",
            isError: event.isError,
            resultText: toolResultText(event.result) || item.partial,
            durationMs: event.durationMs,
          };
        },
      );
      return { items: updated, busy: true };
    }

    case "compaction_start":
      next.push({
        kind: "info",
        id: nextId(),
        text: `压缩上下文中（${event.reason}）…`,
        tone: "info",
      });
      return { items: next, busy: true };

    case "compaction_end": {
      const result = event.result as
        { summary?: string; tokensBefore?: number } | null | undefined;
      next.push({
        kind: "compaction",
        id: nextId(),
        summary: result?.summary ?? "",
        tokensBefore: result?.tokensBefore,
        reason: event.reason,
      });
      return { items: next, busy: event.willRetry };
    }

    case "auto_retry_start":
      next.push({
        kind: "info",
        id: nextId(),
        text: `请求失败，${Math.round(event.delayMs / 1000)}s 后重试（${event.attempt}/${event.maxAttempts}）：${event.errorMessage}`,
        tone: "warn",
      });
      return { items: next, busy: true };

    case "auto_retry_end":
      next.push({
        kind: "info",
        id: nextId(),
        text: event.success
          ? `重试成功（第 ${event.attempt} 次）`
          : `重试失败：${event.finalError ?? "unknown"}`,
        tone: event.success ? "info" : "error",
      });
      return { items: next, busy: true };

    case "thinking_level_changed":
      next.push({
        kind: "info",
        id: nextId(),
        text: `思考档位：${event.level}`,
        tone: "info",
      });
      return { items: next, busy };

    case "extension_error":
      next.push({
        kind: "info",
        id: nextId(),
        text: `扩展错误：${event.error}`,
        tone: "error",
      });
      return { items: next, busy: true };

    default:
      // Unknown or purely informational events are ignored.
      return { items: next, busy };
  }
}
