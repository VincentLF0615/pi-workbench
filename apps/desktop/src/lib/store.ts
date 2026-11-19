import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  api,
  onPiEvents,
  onToasts,
  onSessionOpened,
  onSessionSnapshot,
} from "./api";
import { applyEvent, fromHistory, nextId } from "./transcript";
import { normalizeStats } from "./stats";
import { messageText } from "./types";
import type {
  PiBatch,
  PiQueues,
  PiState,
  SessionFileInfo,
  SessionInfo,
  SessionSnapshot,
  ImageContent,
  Draft,
  UiRequest,
  SessionTreeNode,
  Settings,
  SlashCommand,
  TranscriptItem,
  UiReply,
} from "./types";

/** Live per-session state kept by the frontend. */
export interface SessionRuntime {
  info: SessionInfo;
  transcript: TranscriptItem[];
  state: PiState | null;
  stats: ReturnType<typeof normalizeStats> | null;
  draft: Draft;
  uiRequests: UiRequest[];
  busy: boolean;
  /** Null until Pi provides an authoritative queue_update snapshot. */
  queues: PiQueues | null;
  stopping: boolean;
  extensionStatuses: Record<string, string>;
  extensionWidgets: Record<string, string[]>;
  windowTitle?: string;
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
export function checkPiCompatibility(
  version: string | undefined,
): PiCompatibility {
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

export interface ProjectSummary {
  cwd: string;
  sessions: SessionFileInfo[];
}

export interface UseSessionsResult {
  sessions: SessionRuntime[];
  activeId: string | null;
  active: SessionRuntime | null;
  projects: ProjectSummary[];
  install: {
    found: boolean;
    version?: string;
    error?: string;
    source?: string;
  } | null;
  loading: boolean;
  error: string | null;
  setActiveId: (id: string | null) => void;
  openProject: (projectDir: string, sessionPath?: string) => Promise<void>;
  closeSession: (id: string) => Promise<void>;
  send: (text: string, images?: ImageContent[]) => Promise<void>;
  steer: (text: string, images?: ImageContent[]) => Promise<void>;
  followUp: (text: string, images?: ImageContent[]) => Promise<void>;
  setDraft: (id: string, draft: Draft) => void;
  abort: () => Promise<void>;
  answerUi: (
    requestId: string,
    reply: { kind: "value" | "confirmed" | "cancelled"; value?: string },
  ) => Promise<void>;
  configureModel: (
    provider: string,
    modelId: string,
    thinkingLevel: string,
  ) => Promise<void>;
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

export function emptyRuntime(info: SessionInfo): SessionRuntime {
  return {
    info,
    transcript: [],
    state: null,
    stats: null,
    draft: { text: "", images: [] },
    uiRequests: [],
    busy: false,
    queues: null,
    stopping: false,
    extensionStatuses: {},
    extensionWidgets: {},
    toasts: [],
    tree: null,
    commands: null,
  };
}
export function applySnapshot(
  snapshot: SessionSnapshot,
  previous?: SessionRuntime,
): SessionRuntime {
  if (previous && previous.info.generation > snapshot.info.generation)
    return previous;
  const same = previous?.info.generation === snapshot.info.generation;
  return {
    ...emptyRuntime(snapshot.info),
    ...previous,
    info: snapshot.info,
    transcript: fromHistory(snapshot.messages),
    state: snapshot.state,
    stats: normalizeStats(snapshot.stats),
    busy: !!(snapshot.state.isStreaming || snapshot.state.isCompacting),
    queues: same ? (previous?.queues ?? null) : null,
    stopping: same ? (previous?.stopping ?? false) : false,
    extensionStatuses: same ? previous.extensionStatuses : {},
    extensionWidgets: same ? previous.extensionWidgets : {},
    windowTitle: same ? previous.windowTitle : undefined,
    tree: null,
    uiRequests: same ? previous.uiRequests : [],
  };
}

function notificationTone(
  value: string | undefined,
): "info" | "warn" | "error" {
  if (value === "error") return "error";
  if (value === "warning" || value === "warn") return "warn";
  return "info";
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
  const stoppingRef = useRef(new Set<string>());
  sessionsRef.current = sessions;

  const patch = useCallback(
    (
      sessionId: string,
      change: (runtime: SessionRuntime) => SessionRuntime,
    ) => {
      setSessions((current) =>
        current.map((runtime) =>
          runtime.info.id === sessionId ? change(runtime) : runtime,
        ),
      );
    },
    [],
  );

  const adopt = useCallback((snapshot: SessionSnapshot, focus = false) => {
    setSessions((current) => {
      const existing = current.find(
        (runtime) => runtime.info.id === snapshot.info.id,
      );
      const opened = applySnapshot(snapshot, existing);
      return existing
        ? current.map((runtime) =>
            runtime.info.id === snapshot.info.id ? opened : runtime,
          )
        : [...current, opened];
    });
    if (focus) setActiveId(snapshot.info.id);
    setSettings((current) => {
      if (!current) return current;
      const oldPath = sessionsRef.current.find(
        (runtime) => runtime.info.id === snapshot.info.id,
      )?.info.sessionPath;
      const paths = current.openSessions.filter(
        (path) => path !== oldPath && path !== snapshot.info.sessionPath,
      );
      if (snapshot.info.sessionPath) paths.push(snapshot.info.sessionPath);
      return {
        ...current,
        lastProject: snapshot.info.projectDir,
        openSessions: paths,
      };
    });
  }, []);

  useEffect(
    () =>
      onSessionOpened((info) => {
        setSessions((current) => {
          const existing = current.find(
            (runtime) => runtime.info.id === info.id,
          );
          if (existing && existing.info.generation >= info.generation)
            return current;
          const opened = {
            ...emptyRuntime(info),
            draft: existing?.draft ?? { text: "", images: [] },
          };
          return existing
            ? current.map((runtime) =>
                runtime.info.id === info.id ? opened : runtime,
              )
            : [...current, opened];
        });
        setActiveId((current) => current ?? info.id);
      }),
    [],
  );
  useEffect(() => onSessionSnapshot((snapshot) => adopt(snapshot)), [adopt]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setSessions((current) => {
        let changed = false;
        const next = current.map((runtime) => {
          const requests = runtime.uiRequests.filter(
            (request) => !request.expiresAt || request.expiresAt > Date.now(),
          );
          if (requests.length === runtime.uiRequests.length) return runtime;
          changed = true;
          return { ...runtime, uiRequests: requests };
        });
        return changed ? next : current;
      });
    }, 250);
    return () => window.clearInterval(timer);
  }, []);

  // Boot: discover pi and list known projects.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [found, groups] = await Promise.all([
          api.discoverPi(),
          api.listProjects(),
        ]);
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
          if (
            runtime.info.id !== batch.sessionId ||
            runtime.info.generation !== batch.generation
          )
            return runtime;
          let items = runtime.transcript;
          let busy = runtime.busy;
          let uiRequests = runtime.uiRequests;
          let queues = runtime.queues;
          let pendingMessageCount = runtime.state?.pendingMessageCount;
          let label = runtime.info.label;
          let thinking = runtime.state?.thinkingLevel;
          let extensionStatuses = runtime.extensionStatuses;
          let extensionWidgets = runtime.extensionWidgets;
          let nextWindowTitle = runtime.windowTitle;
          const exited = batch.events.some((e) => e.kind === "exited");

          for (const envelope of batch.events) {
            const result = applyEvent(items, envelope, busy);
            items = result.items;
            busy = result.busy;
            if (
              envelope.kind === "pi" &&
              envelope.event.type === "queue_update"
            ) {
              queues = {
                steering: [...envelope.event.steering],
                followUp: [...envelope.event.followUp],
              };
              pendingMessageCount =
                queues.steering.length + queues.followUp.length;
            }
            if (envelope.kind === "ui") {
              const request = envelope.event;
              if (
                ["select", "confirm", "input", "editor"].includes(
                  request.method,
                )
              ) {
                uiRequests = [
                  ...uiRequests.filter((r) => r.id !== request.id),
                  {
                    ...request,
                    expiresAt:
                      request.timeout != null
                        ? Date.now() + request.timeout
                        : undefined,
                  },
                ];
              } else if (request.method === "notify") {
                items = [
                  ...items,
                  {
                    kind: "info",
                    id: nextId(),
                    text: request.message ?? request.title ?? "通知",
                    tone: notificationTone(request.notifyType),
                  },
                ];
              } else if (request.method === "setStatus") {
                const key = request.statusKey?.trim();
                if (key) {
                  extensionStatuses = { ...extensionStatuses };
                  if (request.statusText?.trim()) {
                    extensionStatuses[key] = request.statusText;
                  } else {
                    delete extensionStatuses[key];
                  }
                }
              } else if (request.method === "setWidget") {
                const key = request.widgetKey?.trim();
                if (key) {
                  extensionWidgets = { ...extensionWidgets };
                  const lines = request.widgetLines ?? [];
                  if (lines.length > 0) extensionWidgets[key] = [...lines];
                  else delete extensionWidgets[key];
                }
              } else if (request.method === "setTitle") {
                nextWindowTitle = request.title?.trim() || undefined;
              }
            }
            if (envelope.kind !== "pi") continue;
            const event = envelope.event;
            if (event.type === "session_info_changed" && event.name)
              label = event.name;
            if (event.type === "thinking_level_changed") thinking = event.level;
          }

          return {
            ...runtime,
            transcript: items,
            busy,
            queues,
            stopping: exited ? false : runtime.stopping,
            uiRequests: exited ? [] : uiRequests,
            extensionStatuses: exited ? {} : extensionStatuses,
            extensionWidgets: exited ? {} : extensionWidgets,
            windowTitle: exited ? undefined : nextWindowTitle,
            info: {
              ...runtime.info,
              label,
              closed: runtime.info.closed || exited,
            },
            state: runtime.state
              ? {
                  ...runtime.state,
                  thinkingLevel: thinking,
                  pendingMessageCount,
                }
              : runtime.state,
          };
        }),
      );
      if (
        sessionsRef.current.some(
          (runtime) =>
            runtime.info.id === batch.sessionId &&
            runtime.info.generation === batch.generation,
        ) &&
        batch.events.some(
          (envelope) =>
            envelope.kind === "pi" && envelope.event.type === "agent_settled",
        )
      ) {
        void Promise.all([
          api.getState(batch.sessionId),
          api.getSessionStats(batch.sessionId),
          api.listProjects(),
        ])
          .then(([state, stats, groups]) => {
            patch(batch.sessionId, (runtime) =>
              runtime.info.generation !== batch.generation
                ? runtime
                : {
                    ...runtime,
                    state,
                    stats: normalizeStats(stats),
                    info: {
                      ...runtime.info,
                      sessionPath:
                        state.sessionFile ?? runtime.info.sessionPath,
                    },
                  },
            );
            setProjects(groups);
          })
          .catch((cause) =>
            console.error("Unable to refresh settled session", cause),
          );
      }
    });

    return unlisten;
  }, [patch]);

  // Toast channel.
  useEffect(() => {
    const unlisten = onToasts((sessionId, message) => {
      toastSeq.current += 1;
      const id = toastSeq.current;
      setSessions((current) =>
        current.map((runtime) =>
          runtime.info.id !== sessionId
            ? runtime
            : { ...runtime, toasts: [...runtime.toasts, { id, message }] },
        ),
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
        adopt(await api.openSession(projectDir, sessionPath), true);
      } catch (cause) {
        setError(String(cause));
        const live = await api.listSessions().catch(() => null);
        if (live)
          setSessions((current) =>
            current.filter((runtime) =>
              live.some((info) => info.id === runtime.info.id),
            ),
          );
      }
    },
    [adopt],
  );

  const closeSession = useCallback(async (id: string) => {
    const closing = sessionsRef.current.find(
      (runtime) => runtime.info.id === id,
    );
    try {
      await api.closeSession(id);
    } catch (cause) {
      setError(String(cause));
      return;
    }
    setSessions((current) =>
      current.filter((runtime) => runtime.info.id !== id),
    );
    setActiveId((current) => (current === id ? null : current));

    // Drop it from the saved list so the next launch does not reopen it.
    const closedPath = closing?.info.sessionPath;
    if (closedPath) {
      setSettings((current) => {
        if (!current) return current;
        const next = {
          ...current,
          openSessions: current.openSessions.filter(
            (path) => path !== closedPath,
          ),
        };
        return next;
      });
    }
  }, []);

  const setDraft = useCallback(
    (id: string, draft: Draft) =>
      patch(id, (runtime) => ({ ...runtime, draft })),
    [patch],
  );

  const send = useCallback(
    async (text: string, images: ImageContent[] = []) => {
      const id = activeId;
      if (!id || (!text.trim() && images.length === 0)) return;
      const itemId = nextId();
      patch(id, (runtime) => ({
        ...runtime,
        busy: true,
        transcript: [
          ...runtime.transcript,
          { kind: "user", id: itemId, text, images: images.length },
        ],
      }));
      try {
        const result = await api.sendPrompt(id, text, images);
        if (result?.disposition === "handled") {
          // Extension/input handlers can consume a command without starting a run.
          patch(id, (runtime) => ({ ...runtime, busy: false }));
        }
      } catch (cause) {
        setError(String(cause));
        patch(id, (runtime) => ({
          ...runtime,
          busy: false,
          transcript: runtime.transcript.filter((item) => item.id !== itemId),
        }));
        throw cause;
      }
    },
    [activeId, patch],
  );

  const steer = useCallback(
    async (text: string, images: ImageContent[] = []) => {
      if (!activeId || (!text.trim() && images.length === 0)) return;
      await api.steer(activeId, text, images);
    },
    [activeId],
  );

  const followUp = useCallback(
    async (text: string, images: ImageContent[] = []) => {
      if (!activeId || (!text.trim() && images.length === 0)) return;
      await api.followUp(activeId, text, images);
    },
    [activeId],
  );

  const abort = useCallback(async () => {
    const id = activeId;
    if (!id) return;
    const current = sessionsRef.current.find(
      (runtime) => runtime.info.id === id,
    );
    if (current?.stopping || stoppingRef.current.has(id)) return;
    stoppingRef.current.add(id);
    setError(null);
    patch(id, (runtime) => ({ ...runtime, stopping: true }));
    try {
      const result = await api.abort(id);
      const recovered = [...result.steering, ...result.followUp]
        .filter((text) => text.trim())
        .join("\n\n");
      patch(id, (runtime) => ({
        ...runtime,
        queues: { steering: [], followUp: [] },
        draft: recovered
          ? {
              ...runtime.draft,
              text: runtime.draft.text
                ? `${recovered}\n\n${runtime.draft.text}`
                : recovered,
            }
          : runtime.draft,
        state: runtime.state
          ? { ...runtime.state, pendingMessageCount: 0 }
          : runtime.state,
      }));
      if (result.abortError) setError(result.abortError);
    } catch (cause) {
      setError(String(cause));
    } finally {
      stoppingRef.current.delete(id);
      patch(id, (runtime) => ({ ...runtime, stopping: false }));
    }
  }, [activeId, patch]);

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
        uiRequests: runtime.uiRequests.filter(
          (request) => request.id !== requestId,
        ),
      }));
    },
    [activeId, patch],
  );

  const configureModel = useCallback(
    async (provider: string, modelId: string, thinkingLevel: string) => {
      const id = activeId;
      if (!id) return;
      try {
        const state = await api.configureModel(
          id,
          provider,
          modelId,
          thinkingLevel,
        );
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
    try {
      await api.compact(id);
    } catch (cause) {
      setError(String(cause));
    }
  }, [activeId]);

  const rename = useCallback(
    async (name: string) => {
      const id = activeId;
      if (!id || !name.trim()) return;
      await api.setSessionName(id, name.trim());
      patch(id, (runtime) => ({
        ...runtime,
        info: { ...runtime.info, label: name.trim() },
      }));
    },
    [activeId, patch],
  );

  const refreshState = useCallback(async () => {
    const id = activeId;
    if (!id) return;
    const [state, stats] = await Promise.all([
      api.getState(id),
      api.getSessionStats(id),
    ]);
    patch(id, (runtime) => ({
      ...runtime,
      state,
      stats: normalizeStats(stats),
    }));
  }, [activeId, patch]);

  const dismissToast = useCallback((toastId: number) => {
    setSessions((current) =>
      current.map((runtime) => ({
        ...runtime,
        toasts: runtime.toasts.filter((toast) => toast.id !== toastId),
      })),
    );
  }, []);

  const branch = useCallback(
    async (entryId?: string): Promise<string | null> => {
      const id = activeId;
      if (!id) return null;
      patch(id, (runtime) => ({ ...runtime, busy: true }));
      try {
        const result = entryId
          ? await api.forkSession(id, entryId)
          : await api.cloneSession(id);
        adopt(result.original);
        if (result.cancelled || !result.branch) return null;
        adopt(result.branch, true);
        if (result.selectedText)
          patch(result.branch.info.id, (runtime) => ({
            ...runtime,
            draft: { ...runtime.draft, text: result.selectedText! },
          }));
        return result.branch.info.sessionPath ?? null;
      } catch (cause) {
        setError(String(cause));
        try {
          adopt(await api.getSessionSnapshot(id));
        } catch {
          const info = (await api.listSessions()).find(
            (info) => info.id === id,
          );
          if (info) patch(id, (runtime) => ({ ...runtime, info, busy: false }));
        }
        return null;
      } finally {
        patch(id, (runtime) => ({ ...runtime, busy: false }));
      }
    },
    [activeId, adopt, patch],
  );
  const fork = useCallback((entryId: string) => branch(entryId), [branch]);
  const clone = useCallback(async () => {
    await branch();
  }, [branch]);

  const deleteSession = useCallback(
    async (sessionPath: string) => {
      // Drop any tab that was showing that file, and refresh the sidebar.
      const doomed = sessionsRef.current.filter(
        (runtime) => runtime.info.sessionPath === sessionPath,
      );
      for (const runtime of doomed) {
        await closeSession(runtime.info.id);
      }
      await api.deleteSession(sessionPath);
      setProjects(
        await api.listProjects().then((groups) =>
          groups.map((group) => ({
            cwd: group.cwd,
            sessions: group.sessions,
          })),
        ),
      );
    },
    [closeSession],
  );

  const switchTo = useCallback(
    async (sessionPath: string) => {
      if (activeId) adopt(await api.switchSession(activeId, sessionPath), true);
    },
    [activeId, adopt],
  );

  const loadTree = useCallback(async () => {
    const id = activeId;
    if (!id) return;
    const expected = sessionsRef.current.find(
      (runtime) => runtime.info.id === id,
    )?.info;
    try {
      const result = await api.getTree(id);
      patch(id, (runtime) =>
        runtime.info.generation !== expected?.generation ||
        runtime.info.sessionPath !== expected.sessionPath
          ? runtime
          : { ...runtime, tree: result.tree ?? [] },
      );
    } catch (cause) {
      setError(String(cause));
    }
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
        const [loaded, location] = await Promise.all([
          api.getSettings(),
          api.settingsLocation(),
        ]);
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
    if (settings.fontFamily.trim())
      root.style.setProperty("--sans", settings.fontFamily);
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
    followUp,
    setDraft,
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
export function projectDirFor(
  sessionPath: string,
  groups: ProjectSummary[],
): string | null {
  for (const group of groups) {
    if (group.sessions.some((session) => session.path === sessionPath)) {
      return group.cwd;
    }
  }
  return null;
}

// Referenced so unused imports stay meaningful for readers of this module.
export type { messageText };
