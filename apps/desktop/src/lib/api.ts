import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type {
  AbortResult,
  BranchResult,
  ImageContent,
  SessionSnapshot,
  FileNode,
  GitFile,
  GitStatus,
  PiBatch,
  PiInstall,
  PiMessage,
  PiModel,
  PiState,
  ProjectGroupInfo,
  SessionEntry,
  SessionFileInfo,
  SessionInfo,
  SessionStats,
  SessionTreeNode,
  Settings,
  SlashCommand,
  StartupIntent,
  TextFile,
  UiReply,
} from "./types";

export type {
  FileNode,
  GitFile,
  GitStatus,
  PiBatch,
  PiInstall,
  ProjectGroupInfo,
  PiMessage,
  PiState,
  SessionEntry,
  SessionFileInfo,
  SessionInfo,
  SessionStats,
  SessionTreeNode,
  Settings,
  SlashCommand,
  StartupIntent,
  TextFile,
  UiReply,
};

const call = <T>(command: string, args?: Record<string, unknown>): Promise<T> =>
  invoke<T>(command, args);

export const api = {
  minimizeToTray: () => call<void>("minimize_to_tray"),
  setWindowTitle: (title: string) => getCurrentWindow().setTitle(title),
  discoverPi: () => call<PiInstall>("discover_pi"),

  listProjects: () => call<ProjectGroupInfo[]>("list_projects"),
  listSessionsFor: (projectDir: string) =>
    call<SessionFileInfo[]>("list_sessions_for", { projectDir }),
  listSessions: () => call<SessionInfo[]>("list_sessions"),

  openSession: (projectDir: string, sessionPath?: string) =>
    call<SessionSnapshot>("open_session", {
      request: { project_dir: projectDir, session_path: sessionPath ?? null },
    }),
  closeSession: (sessionId: string) =>
    call<void>("close_session", { sessionId }),

  getSessionSnapshot: (sessionId: string) =>
    call<SessionSnapshot>("get_session_snapshot", { sessionId }),
  getState: (sessionId: string) => call<PiState>("get_state", { sessionId }),
  getMessages: (sessionId: string) =>
    call<{ messages: PiMessage[] }>("get_messages", { sessionId }),
  getSessionStats: (sessionId: string) =>
    call<SessionStats>("get_session_stats", { sessionId }),
  getAvailableModels: (sessionId: string) =>
    call<{ models: PiModel[] }>("get_available_models", { sessionId }),
  getCommands: (sessionId: string) =>
    call<{
      commands: { name: string; description?: string; source: string }[];
    }>("get_commands", {
      sessionId,
    }),

  sendPrompt: (sessionId: string, text: string, images: ImageContent[] = []) =>
    call<{ disposition?: string }>("send_prompt", { sessionId, text, images }),
  steer: (sessionId: string, text: string, images: ImageContent[] = []) =>
    call<{ disposition?: string }>("steer", { sessionId, text, images }),
  followUp: (sessionId: string, text: string, images: ImageContent[] = []) =>
    call<{ disposition?: string }>("follow_up", { sessionId, text, images }),
  abort: (sessionId: string) => call<AbortResult>("abort", { sessionId }),

  setModel: (sessionId: string, provider: string, modelId: string) =>
    call<void>("set_model", { sessionId, provider, modelId }),
  setThinking: (sessionId: string, level: string) =>
    call<void>("set_thinking", { sessionId, level }),
  configureModel: (
    sessionId: string,
    provider: string,
    modelId: string,
    thinkingLevel: string,
  ) =>
    call<PiState>("configure_model", {
      sessionId,
      provider,
      modelId,
      thinkingLevel,
    }),
  compact: (sessionId: string) =>
    call<Record<string, unknown>>("compact", { sessionId }),
  newSession: (sessionId: string) =>
    call<SessionSnapshot>("new_session", { sessionId }),
  switchSession: (sessionId: string, sessionPath: string) =>
    call<SessionSnapshot>("switch_session", { sessionId, sessionPath }),
  setSessionName: (sessionId: string, name: string) =>
    call<void>("set_session_name", { sessionId, name }),
  exportHtml: (sessionId: string, outputPath?: string) =>
    call<{ path?: string }>("export_html", {
      sessionId,
      outputPath: outputPath ?? null,
    }),

  getTree: (sessionId: string) =>
    call<{ tree: SessionTreeNode[]; leafId: string | null }>("get_tree", {
      sessionId,
    }),
  getEntries: (sessionId: string, since?: string) =>
    call<{ entries: SessionEntry[]; leafId: string | null }>("get_entries", {
      sessionId,
      since: since ?? null,
    }),
  getForkMessages: (sessionId: string) =>
    call<{ messages: { entryId: string; text: string }[] }>(
      "get_fork_messages",
      { sessionId },
    ),
  getSlashCommands: (sessionId: string) =>
    call<{ commands: SlashCommand[] }>("get_commands", { sessionId }),

  forkSession: (sessionId: string, entryId: string) =>
    call<BranchResult>("fork_session", { sessionId, entryId }),
  cloneSession: (sessionId: string) =>
    call<BranchResult>("clone_session", { sessionId }),
  deleteSession: (sessionPath: string) =>
    call<void>("delete_session", { sessionPath }),

  getSettings: () => call<Settings>("get_settings"),
  saveSettings: (settings: Settings) =>
    call<void>("save_settings", { settings }),
  settingsLocation: () => call<string | null>("settings_location"),
  gitStatus: (projectDir: string) =>
    call<GitStatus>("git_status", { projectDir }),
  gitDiff: (projectDir: string, path?: string, staged?: boolean) =>
    call<string>("git_diff", {
      projectDir,
      path: path ?? null,
      staged: staged ?? false,
    }),
  listFiles: (projectDir: string, relative?: string | null, depth?: number) =>
    call<FileNode[]>("list_files", {
      projectDir,
      relative: relative ?? null,
      depth: depth ?? 2,
    }),
  readTextFile: (path: string, maxBytes?: number) =>
    call<TextFile>("read_text_file", { path, maxBytes: maxBytes ?? null }),
  fileLanguage: (path: string) => call<string>("file_language", { path }),
  sessionLogs: (sessionId: string) =>
    call<{ lines: string[] }>("session_logs", { sessionId }),
  takeStartupIntent: () => call<StartupIntent | null>("take_startup_intent"),

  answerUi: (sessionId: string, reply: UiReply) =>
    call<void>("answer_ui", { sessionId, reply }),
};

/** Clean up even if React unmounts before Tauri finishes registering a listener. */
function subscribe<T>(
  channel: string,
  handler: (payload: T) => void,
): UnlistenFn {
  let disposed = false;
  let stop: UnlistenFn | undefined;
  void listen<T>(channel, (event) => {
    if (!disposed) handler(event.payload);
  })
    .then((unlisten) => {
      if (disposed) unlisten();
      else stop = unlisten;
    })
    .catch((cause) => {
      if (!disposed) console.error(`Unable to subscribe to ${channel}`, cause);
    });
  return () => {
    disposed = true;
    stop?.();
  };
}

/** Subscribe to the batched pi event stream. */
export function onPiEvents(handler: (batch: PiBatch) => void): UnlistenFn {
  return subscribe<PiBatch>("pi://event", handler);
}

export function onOpenRequest(handler: () => void): UnlistenFn {
  return subscribe("pi-workbench:open-request", handler);
}

/** Transient error toasts from the backend. */
export function onToasts(
  handler: (sessionId: string, message: string) => void,
): UnlistenFn {
  return subscribe<{ sessionId: string; message: string }>(
    "pi://toast",
    (payload) => handler(payload.sessionId, payload.message),
  );
}

export function onSessionOpened(
  handler: (info: SessionInfo) => void,
): UnlistenFn {
  return subscribe("pi://session-opened", handler);
}
export function onSessionSnapshot(
  handler: (snapshot: SessionSnapshot) => void,
): UnlistenFn {
  return subscribe("pi://session-snapshot", handler);
}
