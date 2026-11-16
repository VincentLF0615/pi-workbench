import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { api, onPiEvents, onToasts } from "./api";
import {
  messageText,
  textOfContent,
  toolResultText,
} from "./types";
import type {
  AssistantBlock,
  PiBatch,
  PiEnvelope,
  PiMessage,
  PiState,
  SessionFileInfo,
  SessionInfo,
  SessionTreeNode,
  Settings,
  SlashCommand,
  TranscriptItem,
  UiReply,
} from "./types";

let itemSeq = 0;
const nextId = () => `i${++itemSeq}`;

/** Live per-session state kept by the frontend. */
export interface SessionRuntime {
  info: SessionInfo;
  transcript: TranscriptItem[];
  state: PiState | null;
  stats: { tokens?: number; contextWindow?: number; percent?: number | null; cost?: number } | null;
  uiRequests: { id: string; method: string; title?: string; message?: string; options: string[]; placeholder?: string; prefill?: string }[];
  busy: boolean;
  toasts: { id: number; message: string }[];
  /** Session tree, loaded on demand. */
  tree: SessionTreeNode[] | null;
  /** pi's slash commands, loaded on demand. */
  commands: SlashCommand[] | null;
}

/**
 * How the installed pi compares to the versions this app was tested against.
 *
 * The protocol is additive, so a newer minor usually still works; a major bump
 * is the case worth warning about.
 */
export type PiCompatibility =
  | { level: "ok"; message: string }
  | { level: "newer"; message: string }
  | { level: "older"; message: string }
  | { level: "unknown"; message: string };

/** pi versions this build has been exercised against. */
export const TESTED_PI = "1.5";

/** Compare an installed pi version against `TESTED_PI`. */
export function checkPiCompatibility(version: string | undefined): PiCompatibility {
  if (!version) {
    return { level: "unknown", message: "无法读取 pi 版本" };
  }
  const match = version.match(/(\d+)\.(\d+)/);
  if (!match) {
    return { level: "unknown", message: `无法解析 pi 版本：${version}` };
  }
  const [major, minor] = [Number(match[1]), Number(match[2])];
  const [testedMajor, testedMinor] = TESTED_PI.split(".").map(Number);

  if (major !== testedMajor) {
    return {
      level: major > testedMajor ? "newer" : "older",
      message: `pi ${version} 与测试版本 ${TESTED_PI}.x 主版本不同，协议可能有变化`,
    };
  }
  if (minor > testedMinor) {
    return {
      level: "newer",
      message: `pi ${version} 比测试版本 ${TESTED_PI}.x 更新，未验证`,
    };
  }
  return { level: "ok", message: `pi ${version} 已兼容` };
}

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
function fromHistory(messages: PiMessage[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const toolIds = new Map<string, string>();

  for (const message of messages) {
    switch (message.role) {
      case "user": {
        const text = textOfContent(message.content);
        if (text.trim()) items.push({ kind: "user", id: nextId(), text, images: 0 });
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
        const item = items.find((entry) => entry.id === toolId && entry.kind === "tool");
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
        items.push({ kind: "info", id: nextId(), text: message.summary, tone: "info" });
        break;
      }
      default:
        break;
    }
  }
  return items;
}

/** Apply one protocol event to a transcript. */
function applyEvent(items: TranscriptItem[], envelope: PiEnvelope, busy: boolean): ReducerResult {
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
      next.push({ kind: "info", id: nextId(), text: envelope.message, tone: "warn" });
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
        if (text.trim() && !(last?.kind === "user" && last.text === text)) {
          next.push({ kind: "user", id: nextId(), text, images: 0 });
        }
      } else if (message.role === "assistant") {
        next.push({ kind: "assistant", id: nextId(), blocks: [], streaming: true });
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
                : (existing as Extract<AssistantBlock, { type: "thinking" }>).thinking;
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
      const updated = patchFirst(next, isToolWithId(event.toolCallId), (item) => {
        if (item.kind !== "tool") return item;
        return { ...item, partial: toolResultText(event.partialResult) || item.partial };
      });
      return { items: updated, busy: true };
    }

    case "tool_execution_end": {
      const updated = patchFirst(next, isToolWithId(event.toolCallId), (item) => {
        if (item.kind !== "tool") return item;
        return {
          ...item,
          state: event.isError ? "error" : "ok",
          isError: event.isError,
          resultText: toolResultText(event.result) || item.partial,
          durationMs: event.durationMs,
        };
      });
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
      const result = event.result as { summary?: string; tokensBefore?: number } | null | undefined;
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
      next.push({ kind: "info", id: nextId(), text: `思考档位：${event.level}`, tone: "info" });
      return { items: next, busy };

    case "extension_error":
      next.push({ kind: "info", id: nextId(), text: `扩展错误：${event.error}`, tone: "error" });
      return { items: next, busy: true };

    default:
      // Unknown or purely informational events are ignored.
      return { items: next, busy };
  }
}

export interface ProjectSummary {
  cwd: string;
  sessions: SessionFileInfo[];
}

export interface UseSessionsResult {
  sessions: SessionRuntime[];
  activeId: string | null;
  active: SessionRuntime | null;
  projects: ProjectSummary[];
  install: { found: boolean; version?: string; error?: string; source?: string } | null;
  loading: boolean;
  error: string | null;
  setActiveId: (id: string | null) => void;
  openProject: (projectDir: string, sessionPath?: string) => Promise<void>;
  closeSession: (id: string) => Promise<void>;
  send: (text: string) => Promise<void>;
  steer: (text: string) => Promise<void>;
  abort: () => Promise<void>;
  answerUi: (
    requestId: string,
    reply: { kind: "value" | "confirmed" | "cancelled"; value?: string },
  ) => Promise<void>;
  configureModel: (provider: string, modelId: string, thinkingLevel: string) => Promise<void>;
  compact: () => Promise<void>;
  rename: (name: string) => Promise<void>;
  refreshState: () => Promise<void>;
  dismissToast: (id: number) => void;
  fork: (entryId: string) => Promise<string | null>;
  clone: () => Promise<void>;
  deleteSession: (sessionPath: string) => Promise<void>;
  switchTo: (sessionPath: string) => Promise<void>;
  loadTree: () => Promise<void>;
  loadCommands: () => Promise<void>;
  settings: Settings | null;
  updateSettings: (patch: Partial<Settings>) => Promise<void>;
  settingsPath: string | null;
  /** How the installed pi compares to the tested version. */
  compatibility: PiCompatibility | null;
}

/**
 * Owns every open session, its transcript, and the event pump.
 *
 * Commands go through `api`; protocol events come back through `onPiEvents`
 * and each batch is folded into the transcript of the session it belongs to.
 */
export function useSessions(): UseSessionsResult {
  const [sessions, setSessions] = useState<SessionRuntime[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [install, setInstall] = useState<UseSessionsResult["install"]>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const toastSeq = useRef(0);
  const sessionsRef = useRef<SessionRuntime[]>([]);
  sessionsRef.current = sessions;

  const patch = useCallback(
    (sessionId: string, change: (runtime: SessionRuntime) => SessionRuntime) => {
      setSessions((current) =>
        current.map((runtime) => (runtime.info.id === sessionId ? change(runtime) : runtime)),
      );
    },
    [],
  );

  // Boot: discover pi and list known projects.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [found, groups] = await Promise.all([api.discoverPi(), api.listProjects()]);
        if (!alive) return;
        setInstall(found);
        setProjects(
          groups.map((group) => ({
            cwd: group.cwd,
            sessions: group.sessions,
          })),
        );
      } catch (cause) {
        if (alive) setError(String(cause));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Event pump.
  useEffect(() => {
    const unlisten = onPiEvents((batch: PiBatch) => {
      setSessions((current) =>
        current.map((runtime) => {
          if (runtime.info.id !== batch.sessionId) return runtime;
          let items = runtime.transcript;
          let busy = runtime.busy;
          let uiRequests = runtime.uiRequests;
          let label = runtime.info.label;
          let thinking = runtime.state?.thinkingLevel;

          for (const envelope of batch.events) {
            const result = applyEvent(items, envelope, busy);
            items = result.items;
            busy = result.busy;
            if (envelope.kind === "ui") uiRequests = [...uiRequests, envelope.event];
            if (envelope.kind !== "pi") continue;
            const event = envelope.event;
            if (event.type === "session_info_changed" && event.name) label = event.name;
            if (event.type === "thinking_level_changed") thinking = event.level;
          }

          return {
            ...runtime,
            transcript: items,
            busy,
            uiRequests,
            info: { ...runtime.info, label },
            state: runtime.state ? { ...runtime.state, thinkingLevel: thinking } : runtime.state,
          };
        }),
      );
      if (batch.events.some((envelope) =>
        envelope.kind === "pi" && envelope.event.type === "agent_settled",
      )) {
        void Promise.all([
          api.getState(batch.sessionId),
          api.getSessionStats(batch.sessionId),
          api.listProjects(),
        ])
          .then(([state, stats, groups]) => {
            patch(batch.sessionId, (runtime) => ({
              ...runtime,
              state,
              stats: normalizeStats(stats),
              info: {
                ...runtime.info,
                sessionPath: state.sessionFile ?? runtime.info.sessionPath,
              },
            }));
            setProjects(groups);
          })
          .catch((cause) => console.error("Unable to refresh settled session", cause));
      }
    });

    return unlisten;
  }, [patch]);

  // Toast channel.
  useEffect(() => {
    const unlisten = onToasts((message) => {
      toastSeq.current += 1;
      const id = toastSeq.current;
      setSessions((current) =>
        current.map((runtime) => ({ ...runtime, toasts: [...runtime.toasts, { id, message }] })),
      );
      window.setTimeout(() => {
        setSessions((current) =>
          current.map((runtime) => ({
            ...runtime,
            toasts: runtime.toasts.filter((toast) => toast.id !== id),
          })),
        );
      }, 8000);
    });
    return unlisten;
  }, []);

  const openProject = useCallback(
    async (projectDir: string, sessionPath?: string) => {
      setError(null);
      try {
        const id = await api.openSession(projectDir, sessionPath);
        const [info, state] = await Promise.all([
          api.listSessions(),
          api.getState(id),
        ]);
        const found = info.find((entry) => entry.id === id);
        let transcript: TranscriptItem[] = [];
        if (sessionPath) {
          const history = await api.getMessages(id);
          transcript = fromHistory(history.messages ?? []);
        }
        const opened: SessionRuntime = {
          info: found ?? {
            id,
            label:
              sessionPath?.split(/[\\/]/).pop() ??
              projectDir.split(/[\\/]/).pop() ??
              id,
            projectDir,
            sessionPath,
            pid: 0,
            launchSource: "",
            closed: false,
          },
          transcript,
          state,
          stats: null,
          uiRequests: [],
          busy: false,
          toasts: [],
          tree: null,
          commands: null,
        };
        setSessions((current) => [...current, opened]);
        setActiveId(id);
        void api.getSessionStats(id).then((stats) => {
          patch(id, (runtime) => ({ ...runtime, stats: normalizeStats(stats) }));
        });

        // Remember what is open so the next launch can restore it.
        const opened_path = opened.info.sessionPath;
        setSettings((current) => {
          if (!current) return current;
          const paths = current.openSessions.filter((path) => path !== opened_path);
          if (opened_path) paths.push(opened_path);
          const next = { ...current, lastProject: projectDir, openSessions: paths };
          return next;
        });
      } catch (cause) {
        setError(String(cause));
      }
    },
    [patch],
  );

  const closeSession = useCallback(
    async (id: string) => {
      const closing = sessionsRef.current.find((runtime) => runtime.info.id === id);
      try {
        await api.closeSession(id);
      } catch {
        // A session whose pi already died is still closed from our side.
      }
      setSessions((current) => current.filter((runtime) => runtime.info.id !== id));
      setActiveId((current) => (current === id ? null : current));

      // Drop it from the saved list so the next launch does not reopen it.
      const closedPath = closing?.info.sessionPath;
      if (closedPath) {
        setSettings((current) => {
          if (!current) return current;
          const next = {
            ...current,
            openSessions: current.openSessions.filter((path) => path !== closedPath),
          };
          return next;
        });
      }
    },
    [],
  );

  const send = useCallback(
    async (text: string) => {
      const id = activeId;
      if (!id || !text.trim()) return;
      setSessions((current) =>
        current.map((runtime) =>
          runtime.info.id === id
            ? {
                ...runtime,
                transcript: [
                  ...runtime.transcript,
                  { kind: "user", id: nextId(), text, images: 0 },
                ],
                busy: true,
              }
            : runtime,
        ),
      );
      try {
        await api.sendPrompt(id, text);
      } catch (cause) {
        setError(String(cause));
        patch(id, (runtime) => ({ ...runtime, busy: false }));
      }
    },
    [activeId, patch],
  );

  const steer = useCallback(
    async (text: string) => {
      const id = activeId;
      if (!id || !text.trim()) return;
      setSessions((current) =>
        current.map((runtime) =>
          runtime.info.id === id
            ? {
                ...runtime,
                transcript: [
                  ...runtime.transcript,
                  { kind: "info", id: nextId(), text: `追加指令：${text}`, tone: "info" },
                ],
              }
            : runtime,
        ),
      );
      await api.steer(id, text);
    },
    [activeId],
  );

  const abort = useCallback(async () => {
    const id = activeId;
    if (!id) return;
    await api.abort(id);
  }, [activeId]);

  const answerUi = useCallback(
    async (
      requestId: string,
      reply: { kind: "value" | "confirmed" | "cancelled"; value?: string },
    ) => {
      const id = activeId;
      if (!id) return;
      const payload: UiReply =
        reply.kind === "cancelled"
          ? { kind: "cancelled", requestId }
          : reply.kind === "confirmed"
            ? { kind: "confirmed", requestId, value: reply.value === "true" }
            : { kind: "value", requestId, value: reply.value ?? "" };
      await api.answerUi(id, payload);
      patch(id, (runtime) => ({
        ...runtime,
        uiRequests: runtime.uiRequests.filter((request) => request.id !== requestId),
      }));
    },
    [activeId, patch],
  );

  const configureModel = useCallback(
    async (provider: string, modelId: string, thinkingLevel: string) => {
      const id = activeId;
      if (!id) return;
      try {
        const state = await api.configureModel(id, provider, modelId, thinkingLevel);
        patch(id, (runtime) => ({ ...runtime, state }));
      } catch (cause) {
        // A failed rollback must still show Pi's actual state in the toolbar.
        try {
          const state = await api.getState(id);
          patch(id, (runtime) => ({ ...runtime, state }));
        } catch (refreshError) {
          console.error("Unable to refresh model selection", refreshError);
        }
        throw cause;
      }
    },
    [activeId, patch],
  );

  const compact = useCallback(async () => {
    const id = activeId;
    if (!id) return;
    await api.compact(id);
  }, [activeId]);

  const rename = useCallback(
    async (name: string) => {
      const id = activeId;
      if (!id || !name.trim()) return;
      await api.setSessionName(id, name.trim());
      patch(id, (runtime) => ({ ...runtime, info: { ...runtime.info, label: name.trim() } }));
    },
    [activeId, patch],
  );

  const refreshState = useCallback(async () => {
    const id = activeId;
    if (!id) return;
    const [state, stats] = await Promise.all([api.getState(id), api.getSessionStats(id)]);
    patch(id, (runtime) => ({ ...runtime, state, stats: normalizeStats(stats) }));
  }, [activeId, patch]);

  const dismissToast = useCallback((toastId: number) => {
    setSessions((current) =>
      current.map((runtime) => ({
        ...runtime,
        toasts: runtime.toasts.filter((toast) => toast.id !== toastId),
      })),
    );
  }, []);

  const fork = useCallback(
    async (entryId: string) => {
      const id = activeId;
      if (!id) return null;
      await api.forkSession(id, entryId);
      // pi opened a new session file; pick it up so the sidebar and the state
      // reflect it, then open a second tab for it.
      const state = await api.getState(id);
      const path = state?.sessionFile;
      if (!path) return null;
      const info = (await api.listSessions()).find((entry) => entry.id === id);
      if (info?.sessionPath && info.sessionPath !== path) {
        await openProject(info.projectDir, path);
        return path;
      }
      patch(id, (runtime) => ({ ...runtime, state }));
      return path;
    },
    [activeId, openProject, patch],
  );

  const clone = useCallback(async () => {
    const id = activeId;
    if (!id) return;
    await api.cloneSession(id);
    const state = await api.getState(id);
    const info = (await api.listSessions()).find((entry) => entry.id === id);
    if (info?.sessionPath && state?.sessionFile && info.sessionPath !== state.sessionFile) {
      await openProject(info.projectDir, state.sessionFile);
    } else {
      patch(id, (runtime) => ({ ...runtime, state }));
    }
  }, [activeId, openProject, patch]);

  const deleteSession = useCallback(async (sessionPath: string) => {
    await api.deleteSession(sessionPath);
    // Drop any tab that was showing that file, and refresh the sidebar.
    const doomed = sessionsRef.current.filter(
      (runtime) => runtime.info.sessionPath === sessionPath,
    );
    for (const runtime of doomed) {
      await closeSession(runtime.info.id);
    }
    setProjects(await api.listProjects().then((groups) =>
      groups.map((group) => ({ cwd: group.cwd, sessions: group.sessions })),
    ));
  }, [closeSession]);

  const switchTo = useCallback(
    async (sessionPath: string) => {
      const id = activeId;
      if (!id) return;
      await api.switchSession(id, sessionPath);
      const [state, history] = await Promise.all([
        api.getState(id),
        api.getMessages(id),
      ]);
      patch(id, (runtime) => ({
        ...runtime,
        state,
        transcript: fromHistory(history.messages ?? []),
      }));
    },
    [activeId, patch],
  );

  const loadTree = useCallback(async () => {
    const id = activeId;
    if (!id) return;
    const result = await api.getTree(id);
    patch(id, (runtime) => ({ ...runtime, tree: result.tree ?? [] }));
  }, [activeId, patch]);

  const loadCommands = useCallback(async () => {
    const id = activeId;
    if (!id) return;
    const result = await api.getSlashCommands(id);
    patch(id, (runtime) => ({ ...runtime, commands: result.commands ?? [] }));
  }, [activeId, patch]);

  const [settings, setSettings] = useState<Settings | null>(null);
  const [settingsPath, setSettingsPath] = useState<string | null>(null);
  const restored = useRef(false);
  const settingsWrites = useRef(Promise.resolve());

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [loaded, location] = await Promise.all([api.getSettings(), api.settingsLocation()]);
        if (!alive) return;
        setSettings({ ...defaultSettings, ...loaded });
        setSettingsPath(location);
      } catch (cause) {
        if (alive) setError(String(cause));
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const updateSettings = useCallback(async (patchValue: Partial<Settings>) => {
    setSettings((current) => {
      const next = { ...(current ?? defaultSettings), ...patchValue };
      return next;
    });
  }, []);

  // Keep state updates pure and serialize atomic file writes. StrictMode can
  // run an updater twice, and overlapping writes otherwise share one .tmp file.
  useEffect(() => {
    if (!settings) return;
    settingsWrites.current = settingsWrites.current
      .then(() => api.saveSettings(settings))
      .catch((cause) => setError(String(cause)));
  }, [settings]);

  useEffect(() => {
    if (!settings) return;
    const root = document.documentElement;
    root.dataset.theme = settings.theme;
    root.style.setProperty("--transcript-font-size", `${settings.fontSize}px`);
    if (settings.fontFamily.trim()) root.style.setProperty("--sans", settings.fontFamily);
    else root.style.removeProperty("--sans");
  }, [settings]);

  // Restore the last workspace, or open what this launch was asked to open.
  //
  // Order matters: an explicit command line (or a second launch forwarded by
  // the single-instance plugin) wins over the saved state.
  useEffect(() => {
    if (restored.current || loading || !settings) return;
    restored.current = true;

    void (async () => {
      const intent = await api.takeStartupIntent();
      if (intent?.session_path) {
        const dir = projectDirFor(intent.session_path, projects);
        if (dir) await openProject(dir, intent.session_path);
        return;
      }
      if (intent?.project_dir) {
        await openProject(intent.project_dir);
        return;
      }

      // Nothing asked for: reopen the sessions saved last time.
      const saved = settings.openSessions;
      if (saved.length === 0) {
        if (settings.lastProject) await openProject(settings.lastProject);
        return;
      }
      for (const path of saved) {
        const dir = projectDirFor(path, projects);
        if (dir) await openProject(dir, path);
      }
    })();
  }, [settings, projects, openProject, loading]);

  const active = useMemo(
    () => sessions.find((runtime) => runtime.info.id === activeId) ?? null,
    [sessions, activeId],
  );

  const compatibility = useMemo(
    () => (install?.found ? checkPiCompatibility(install.version) : null),
    [install],
  );

  return {
    sessions,
    activeId,
    active,
    projects,
    install,
    loading,
    error,
    setActiveId,
    openProject,
    closeSession,
    send,
    steer,
    abort,
    answerUi,
    configureModel,
    compact,
    rename,
    refreshState,
    dismissToast,
    fork,
    clone,
    deleteSession,
    switchTo,
    loadTree,
    loadCommands,
    settings,
    updateSettings,
    settingsPath,
    compatibility,
  };
}

const defaultSettings: Settings = {
  theme: "light",
  fontSize: 14,
  fontFamily: "",
  sidebarWidth: 300,
  lastProject: null,
  openSessions: [],
  expandTools: false,
  logLevel: "info",
  minimizeToTray: true,
};

/**
 * Which project a saved session file belongs to.
 *
 * The session header records the working directory it was created in, which is
 * exactly the `cwd` pi needs to resume it, so we look the file up in the
 * project groups rather than storing a second copy of that mapping.
 */
export function projectDirFor(sessionPath: string, groups: ProjectSummary[]): string | null {
  for (const group of groups) {
    if (group.sessions.some((session) => session.path === sessionPath)) {
      return group.cwd;
    }
  }
  return null;
}

function normalizeStats(stats: {
  tokens?: { totalTokens?: number };
  contextUsage?: { tokens?: number | null; contextWindow?: number; percent?: number | null };
  cost?: number;
}): SessionRuntime["stats"] {
  return {
    tokens: stats.tokens?.totalTokens,
    contextWindow: stats.contextUsage?.contextWindow,
    percent: stats.contextUsage?.percent,
    cost: stats.cost,
  };
}

// Referenced so unused imports stay meaningful for readers of this module.
export type { messageText };
