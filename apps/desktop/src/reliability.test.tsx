import { useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Draft,
  PiBatch,
  PiQueues,
  SessionInfo,
  SessionSnapshot,
  Settings,
  UiReply,
} from "./lib/types";
import contracts from "../../../fixtures/contracts/ui-replies.json";

const dialogMocks = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: dialogMocks.open }));
const externalMocks = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("./lib/external", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/external")>();
  return { ...actual, openExternal: externalMocks.open };
});

const mocks = vi.hoisted(() => ({
  events: undefined as undefined | ((batch: PiBatch) => void),
  opened: undefined as undefined | ((info: SessionInfo) => void),
  snapshot: undefined as undefined | ((snapshot: SessionSnapshot) => void),
  api: {
    setWindowTitle: vi.fn(),
    discoverPi: vi.fn(),
    listProjects: vi.fn(),
    getSettings: vi.fn(),
    settingsLocation: vi.fn(),
    saveSettings: vi.fn(),
    takeStartupIntent: vi.fn(),
    openSession: vi.fn(),
    closeSession: vi.fn(),
    listSessions: vi.fn(),
    getSessionStats: vi.fn(),
    getState: vi.fn(),
    getTree: vi.fn(),
    getSlashCommands: vi.fn(),
    getAvailableModels: vi.fn(),
    getForkMessages: vi.fn(),
    listFiles: vi.fn(),
    getSessionSnapshot: vi.fn(),
    sendPrompt: vi.fn(),
    steer: vi.fn(),
    followUp: vi.fn(),
    answerUi: vi.fn(),
    forkSession: vi.fn(),
    cloneSession: vi.fn(),
    setSessionName: vi.fn(),
    deleteSession: vi.fn(),
    abort: vi.fn(),
  },
}));
vi.mock("./lib/api", () => ({
  api: mocks.api,
  onPiEvents: (handler: (batch: PiBatch) => void) => {
    mocks.events = handler;
    return () => {
      mocks.events = undefined;
    };
  },
  onSessionOpened: (handler: (info: SessionInfo) => void) => {
    mocks.opened = handler;
    return () => {};
  },
  onSessionSnapshot: (handler: (snapshot: SessionSnapshot) => void) => {
    mocks.snapshot = handler;
    return () => {};
  },
  onToasts: () => () => {},
  onOpenRequest: () => () => {},
}));
import App from "./App";
import { Composer, ExtensionDialogs } from "./components/Composer";
import { Transcript } from "./components/Transcript";
import { Markdown } from "./components/Markdown";
import { useSessions } from "./lib/store";
import { normalizeStats } from "./lib/stats";
import { validateImages, MAX_IMAGE_BYTES } from "./lib/images";

const base: SessionSnapshot = {
  info: {
    id: "s1",
    label: "original",
    projectDir: "C:/project",
    sessionPath: "C:/sessions/original.jsonl",
    pid: 1,
    generation: 1,
    launchSource: "mock",
    closed: false,
  },
  state: {
    sessionFile: "C:/sessions/original.jsonl",
    isStreaming: false,
    model: { id: "mock", provider: "offline", input: ["text", "image"] },
  },
  messages: [],
  stats: {
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    totalMessages: 0,
    tokens: { input: 100, output: 23, cacheRead: 0, cacheWrite: 0, total: 123 },
    cost: 0,
    contextUsage: { tokens: 80, contextWindow: 10000, percent: 0.8 },
  },
};
const settings: Settings = {
  theme: "light",
  fontSize: 14,
  fontFamily: "",
  sidebarWidth: 300,
  openSessions: [],
  lastProject: null,
  expandTools: false,
  logLevel: "info",
  minimizeToTray: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  dialogMocks.open.mockResolvedValue(null);
  externalMocks.open.mockResolvedValue(undefined);
  mocks.api.setWindowTitle.mockResolvedValue(undefined);
  mocks.api.discoverPi.mockResolvedValue({ found: true, version: "1.5.2" });
  mocks.api.listProjects.mockResolvedValue([]);
  mocks.api.getSettings.mockResolvedValue(settings);
  mocks.api.settingsLocation.mockResolvedValue("test-settings");
  mocks.api.saveSettings.mockResolvedValue(undefined);
  mocks.api.takeStartupIntent.mockResolvedValue(null);
  mocks.api.openSession.mockResolvedValue(base);
  mocks.api.listSessions.mockResolvedValue([base.info]);
  mocks.api.closeSession.mockResolvedValue(undefined);
  mocks.api.getSessionStats.mockResolvedValue(base.stats);
  mocks.api.getState.mockResolvedValue(base.state);
  mocks.api.getTree.mockResolvedValue({ tree: [] });
  mocks.api.getSlashCommands.mockResolvedValue({ commands: [] });
  mocks.api.getAvailableModels.mockResolvedValue({
    models: [{ ...base.state.model!, supportedThinkingLevels: ["off"] }],
  });
  mocks.api.getForkMessages.mockResolvedValue({ messages: [] });
  mocks.api.listFiles.mockResolvedValue([]);
  mocks.api.getSessionSnapshot.mockResolvedValue(base);
  mocks.api.sendPrompt.mockResolvedValue({});
  mocks.api.steer.mockResolvedValue({});
  mocks.api.followUp.mockResolvedValue({});
  mocks.api.abort.mockResolvedValue({
    steering: [],
    followUp: [],
    abortError: null,
  });
  mocks.api.answerUi.mockResolvedValue(undefined);
  mocks.api.setSessionName.mockResolvedValue(undefined);
  mocks.api.deleteSession.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("session lifecycle", () => {
  it("deduplicates open responses and isolates drafts by tab", async () => {
    const { result } = renderHook(() => useSessions());
    await waitFor(() => expect(result.current.settings).not.toBeNull());
    await act(async () => {
      await result.current.openProject("C:/project");
      await result.current.openProject("C:/project");
    });
    expect(result.current.sessions).toHaveLength(1);
    act(() => result.current.setDraft("s1", { text: "draft A", images: [] }));
    mocks.api.openSession.mockResolvedValueOnce({
      ...base,
      info: { ...base.info, id: "s2", sessionPath: "C:/sessions/other.jsonl" },
    });
    await act(async () => result.current.openProject("C:/project"));
    expect(result.current.active?.draft.text).toBe("");
    act(() => result.current.setActiveId("s1"));
    expect(result.current.active?.draft.text).toBe("draft A");
  });
  it("clears optimistic busy when a command is handled without a run", async () => {
    const { result } = renderHook(() => useSessions());
    await waitFor(() => expect(result.current.settings).not.toBeNull());
    await act(async () => {
      await result.current.openProject("C:/project");
    });
    mocks.api.sendPrompt.mockResolvedValue({ disposition: "handled" });
    await act(async () => {
      await result.current.send("/demo");
    });
    expect(result.current.active?.busy).toBe(false);
    expect(result.current.active?.transcript[0]).toMatchObject({
      kind: "user",
      text: "/demo",
    });
  });

  it("ignores old process events after replacement and expires dialogs", async () => {
    const { result } = renderHook(() => useSessions());
    await waitFor(() => expect(result.current.settings).not.toBeNull());
    await act(async () => result.current.openProject("C:/project"));
    act(() =>
      mocks.snapshot?.({ ...base, info: { ...base.info, generation: 2 } }),
    );
    act(() =>
      mocks.events?.({
        sessionId: "s1",
        generation: 1,
        events: [{ kind: "exited", code: 7 }],
      }),
    );
    expect(result.current.active?.info.closed).toBe(false);
    act(() =>
      mocks.events?.({
        sessionId: "s1",
        generation: 2,
        events: [
          {
            kind: "ui",
            event: { id: "u1", method: "confirm", options: [], timeout: 10 },
          },
        ],
      }),
    );
    expect(result.current.active?.uiRequests).toHaveLength(1);
    await waitFor(() =>
      expect(result.current.active?.uiRequests).toHaveLength(0),
    );
  });
  it("keeps original after branching and prefills the new draft", async () => {
    const forked = {
      ...base,
      info: { ...base.info, id: "s2", sessionPath: "C:/sessions/branch.jsonl" },
    };
    mocks.api.forkSession.mockResolvedValue({
      cancelled: false,
      original: base,
      branch: forked,
      selectedText: "selected question",
    });
    const { result } = renderHook(() => useSessions());
    await waitFor(() => expect(result.current.settings).not.toBeNull());
    await act(async () => result.current.openProject("C:/project"));
    await act(async () => result.current.fork("entry-1"));
    expect(result.current.sessions).toHaveLength(2);
    expect(result.current.sessions[0].info.sessionPath).toBe(
      base.info.sessionPath,
    );
    expect(result.current.activeId).toBe("s2");
    expect(result.current.active?.draft.text).toBe("selected question");
    expect(mocks.api.sendPrompt).not.toHaveBeenCalled();
  });
  it("uses the same UI reply contract as Rust", async () => {
    const { result } = renderHook(() => useSessions());
    await waitFor(() => expect(result.current.settings).not.toBeNull());
    await act(async () => result.current.openProject("C:/project"));
    for (const contract of contracts) {
      const reply = contract.request as UiReply;
      await act(async () =>
        result.current.answerUi(reply.requestId, {
          kind: reply.kind,
          value: reply.kind === "cancelled" ? undefined : String(reply.value),
        }),
      );
      expect(mocks.api.answerUi).toHaveBeenLastCalledWith("s1", reply);
    }
  });
});

describe("message queues and stopping", () => {
  it("tracks authoritative queues per session and process generation", async () => {
    const { result } = renderHook(() => useSessions());
    await waitFor(() => expect(result.current.settings).not.toBeNull());
    await act(async () => {
      await result.current.openProject("C:/project");
    });
    const second = {
      ...base,
      info: { ...base.info, id: "s2", sessionPath: "C:/sessions/two.jsonl" },
    };
    mocks.api.openSession.mockResolvedValueOnce(second);
    await act(async () => {
      await result.current.openProject("D:/other");
    });

    act(() =>
      mocks.events?.({
        sessionId: "s1",
        generation: 1,
        events: [
          {
            kind: "pi",
            event: {
              type: "queue_update",
              steering: ["one steer"],
              followUp: ["one follow-up"],
            },
          },
        ],
      }),
    );
    expect(result.current.sessions[0].queues).toEqual({
      steering: ["one steer"],
      followUp: ["one follow-up"],
    });
    expect(result.current.sessions[0].state?.pendingMessageCount).toBe(2);

    act(() =>
      mocks.events?.({
        sessionId: "s2",
        generation: 1,
        events: [
          {
            kind: "pi",
            event: {
              type: "queue_update",
              steering: ["other session"],
              followUp: [],
            },
          },
        ],
      }),
    );
    expect(result.current.sessions[0].queues?.steering).toEqual(["one steer"]);
    expect(result.current.sessions[1].queues?.steering).toEqual([
      "other session",
    ]);

    act(() =>
      mocks.snapshot?.({ ...base, info: { ...base.info, generation: 2 } }),
    );
    expect(result.current.sessions[0].queues).toBeNull();
    act(() =>
      mocks.events?.({
        sessionId: "s1",
        generation: 1,
        events: [
          {
            kind: "pi",
            event: {
              type: "queue_update",
              steering: ["stale"],
              followUp: [],
            },
          },
        ],
      }),
    );
    expect(result.current.sessions[0].queues).toBeNull();

    act(() =>
      mocks.events?.({
        sessionId: "s1",
        generation: 2,
        events: [
          {
            kind: "pi",
            event: {
              type: "queue_update",
              steering: ["current"],
              followUp: [],
            },
          },
        ],
      }),
    );
    expect(result.current.sessions[0].queues?.steering).toEqual(["current"]);
  });

  it("shows count-only queue information until text is authoritative", () => {
    render(
      <ComposerHarness
        send={vi.fn().mockResolvedValue(undefined)}
        busy
        pendingMessageCount={2}
      />,
    );
    fireEvent.click(screen.getByText("排队消息 · 2"));
    expect(screen.getByText(/Pi 尚未提供排队文本/)).toBeTruthy();
  });

  it("selects steer or follow-up and clears drafts only after acceptance", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const steer = vi.fn().mockResolvedValue(undefined);
    const followUp = vi.fn().mockResolvedValue(undefined);
    render(
      <ComposerHarness send={send} steer={steer} followUp={followUp} busy />,
    );
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "change direction" } });
    fireEvent.click(screen.getByRole("button", { name: "追加指令" }));
    await waitFor(() =>
      expect(steer).toHaveBeenCalledWith("change direction", []),
    );
    expect(followUp).not.toHaveBeenCalled();
    await waitFor(() => expect((input as HTMLTextAreaElement).value).toBe(""));

    fireEvent.change(input, { target: { value: "after this task" } });
    fireEvent.click(screen.getByRole("button", { name: "稍后跟进" }));
    await waitFor(() =>
      expect(followUp).toHaveBeenCalledWith("after this task", []),
    );
    await waitFor(() => expect((input as HTMLTextAreaElement).value).toBe(""));
  });

  it("keeps a rejected follow-up draft", async () => {
    render(
      <ComposerHarness
        send={vi.fn().mockResolvedValue(undefined)}
        followUp={vi.fn().mockRejectedValue(new Error("offline"))}
        busy
      />,
    );
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "keep this follow-up" },
    });
    fireEvent.click(screen.getByRole("button", { name: "稍后跟进" }));
    await screen.findByRole("alert");
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
      "keep this follow-up",
    );
  });

  it("restores returned queue text once and preserves the existing draft", async () => {
    const { result } = renderHook(() => useSessions());
    await waitFor(() => expect(result.current.settings).not.toBeNull());
    await act(async () => {
      await result.current.openProject("C:/project");
    });
    const image = {
      type: "image" as const,
      mimeType: "image/png",
      data: "AQID",
    };
    act(() =>
      result.current.setDraft("s1", {
        text: "existing draft",
        images: [image],
      }),
    );
    mocks.api.abort.mockResolvedValue({
      steering: ["adjust"],
      followUp: ["later"],
      abortError: null,
    });
    await act(async () => {
      await result.current.abort();
    });
    expect(result.current.active?.draft).toEqual({
      text: "adjust\n\nlater\n\nexisting draft",
      images: [image],
    });
    expect(result.current.active?.queues).toEqual({
      steering: [],
      followUp: [],
    });
    expect(result.current.active?.state?.pendingMessageCount).toBe(0);
    act(() =>
      mocks.events?.({
        sessionId: "s1",
        generation: 1,
        events: [
          {
            kind: "pi",
            event: { type: "queue_update", steering: [], followUp: [] },
          },
        ],
      }),
    );
    expect(result.current.active?.draft.text).toBe(
      "adjust\n\nlater\n\nexisting draft",
    );
    expect(mocks.api.abort).toHaveBeenCalledTimes(1);
  });

  it("deduplicates immediate stop calls before React rerenders", async () => {
    const { result } = renderHook(() => useSessions());
    await waitFor(() => expect(result.current.settings).not.toBeNull());
    await act(async () => {
      await result.current.openProject("C:/project");
    });
    let resolveAbort!: (value: {
      steering: string[];
      followUp: string[];
      abortError: null;
    }) => void;
    mocks.api.abort.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveAbort = resolve;
        }),
    );
    await act(async () => {
      const first = result.current.abort();
      const second = result.current.abort();
      expect(mocks.api.abort).toHaveBeenCalledTimes(1);
      resolveAbort({ steering: [], followUp: [], abortError: null });
      await Promise.all([first, second]);
    });
    expect(result.current.active?.stopping).toBe(false);
  });

  it("keeps queue and draft after clear failure", async () => {
    const { result } = renderHook(() => useSessions());
    await waitFor(() => expect(result.current.settings).not.toBeNull());
    await act(async () => {
      await result.current.openProject("C:/project");
    });
    act(() => {
      result.current.setDraft("s1", { text: "draft", images: [] });
      mocks.events?.({
        sessionId: "s1",
        generation: 1,
        events: [
          {
            kind: "pi",
            event: {
              type: "queue_update",
              steering: ["still queued"],
              followUp: [],
            },
          },
        ],
      });
    });
    mocks.api.abort.mockRejectedValue(new Error("clear failed"));
    await act(async () => {
      await result.current.abort();
    });
    expect(result.current.active?.queues?.steering).toEqual(["still queued"]);
    expect(result.current.active?.draft.text).toBe("draft");
    expect(result.current.active?.stopping).toBe(false);
    expect(result.current.error).toContain("clear failed");
  });

  it("recovers text and surfaces an abort failure after clearing", async () => {
    const { result } = renderHook(() => useSessions());
    await waitFor(() => expect(result.current.settings).not.toBeNull());
    await act(async () => {
      await result.current.openProject("C:/project");
    });
    mocks.api.abort.mockResolvedValue({
      steering: ["recovered"],
      followUp: [],
      abortError: "abort failed",
    });
    await act(async () => {
      await result.current.abort();
    });
    expect(result.current.active?.draft.text).toBe("recovered");
    expect(result.current.error).toBe("abort failed");
    expect(result.current.active?.stopping).toBe(false);
  });
});

it("opening the session tree does not create a request loop", async () => {
  mocks.api.getSettings.mockResolvedValue({
    ...settings,
    lastProject: "C:/project",
  });
  render(<App />);
  await screen.findByRole("button", { name: "会话树" });
  fireEvent.click(screen.getByRole("button", { name: "会话树" }));
  await waitFor(() => expect(mocks.api.getTree).toHaveBeenCalledTimes(1));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 80));
  });
  expect(mocks.api.getTree).toHaveBeenCalledTimes(1);
});

async function renderBusyApp() {
  const snapshot = {
    ...base,
    state: { ...base.state, isStreaming: true, pendingMessageCount: 0 },
  };
  mocks.api.openSession.mockResolvedValue(snapshot);
  mocks.api.getState.mockResolvedValue(snapshot.state);
  mocks.api.getSettings.mockResolvedValue({
    ...settings,
    lastProject: "C:/project",
  });
  render(<App />);
  await screen.findByRole("button", { name: "追加指令" });
}

it("keeps Escape inside overlays and aborts only an unhandled Escape", async () => {
  await renderBusyApp();

  const command = screen.getByRole("button", { name: "命令" });
  command.focus();
  fireEvent.click(command);
  let dialog = await screen.findByRole("dialog", { name: "Pi 命令面板" });
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByPlaceholderText(/搜索命令/),
    ),
  );
  fireEvent.keyDown(dialog, { key: "Escape" });
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Pi 命令面板" })).toBeNull(),
  );
  expect(mocks.api.abort).not.toHaveBeenCalled();
  await waitFor(() => expect(document.activeElement).toBe(command));

  const settingsButton = screen.getByRole("button", { name: "设置" });
  settingsButton.focus();
  fireEvent.click(settingsButton);
  dialog = await screen.findByRole("dialog", { name: "设置" });
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByText("跟随系统")),
  );
  fireEvent.keyDown(dialog, { key: "Escape" });
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "设置" })).toBeNull(),
  );
  expect(mocks.api.abort).not.toHaveBeenCalled();
  await waitFor(() => expect(document.activeElement).toBe(settingsButton));

  const model = screen.getByRole("button", { name: /选择模型/ });
  model.focus();
  fireEvent.click(model);
  dialog = await screen.findByRole("dialog", { name: "选择模型" });
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByPlaceholderText(/搜索模型名称/),
    ),
  );
  fireEvent.keyDown(dialog, { key: "Escape" });
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "选择模型" })).toBeNull(),
  );
  expect(mocks.api.abort).not.toHaveBeenCalled();
  await waitFor(() => expect(document.activeElement).toBe(model));

  const tab = document.querySelector(".tab")!;
  fireEvent.contextMenu(tab);
  await screen.findByRole("menu");
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  expect(mocks.api.abort).not.toHaveBeenCalled();

  fireEvent.contextMenu(tab);
  fireEvent.click(await screen.findByRole("menuitem", { name: "从这里分叉…" }));
  dialog = await screen.findByRole("dialog", { name: "从哪条消息分叉？" });
  fireEvent.keyDown(dialog, { key: "Escape" });
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "从哪条消息分叉？" }),
    ).toBeNull(),
  );
  expect(mocks.api.abort).not.toHaveBeenCalled();

  fireEvent.keyDown(document.body, { key: "Escape" });
  await waitFor(() => expect(mocks.api.abort).toHaveBeenCalledTimes(1));
});

it("wraps Tab and Shift+Tab inside a shared dialog", async () => {
  await renderBusyApp();
  fireEvent.click(screen.getByRole("button", { name: "设置" }));
  await screen.findByRole("dialog", { name: "设置" });
  const first = screen.getByText("跟随系统");
  const last = screen.getByRole("button", { name: "完成" });
  await waitFor(() => expect(document.activeElement).toBe(first));

  last.focus();
  fireEvent.keyDown(last, { key: "Tab" });
  expect(document.activeElement).toBe(first);
  first.focus();
  fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(last);
});

it("opens the native directory picker on fresh settings", async () => {
  render(<App />);
  const newSession = await screen.findByRole("button", { name: "新会话" });
  mocks.api.openSession.mockClear();
  fireEvent.click(newSession);
  await waitFor(() =>
    expect(dialogMocks.open).toHaveBeenCalledWith(
      expect.objectContaining({ directory: true, multiple: false }),
    ),
  );
  expect(mocks.api.openSession).not.toHaveBeenCalled();
});

it("opens the directory returned by the native picker", async () => {
  const projectDir = "C:/项目 with space";
  dialogMocks.open.mockResolvedValue(projectDir);
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "新会话" }));
  await waitFor(() =>
    expect(mocks.api.openSession).toHaveBeenCalledWith(projectDir, undefined),
  );
});

it("falls back to the inline path if the native picker fails", async () => {
  dialogMocks.open.mockRejectedValue(new Error("unsupported"));
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "新会话" }));
  const input = await screen.findByPlaceholderText(/项目目录/);
  await waitFor(() => expect(document.activeElement).toBe(input));
  expect(screen.getByRole("alert").textContent).toContain("手动输入路径");
  expect(mocks.api.openSession).not.toHaveBeenCalled();
});

it("keeps manual project path entry available", async () => {
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "手动输入路径" }));
  const input = await screen.findByPlaceholderText(/项目目录/);
  const projectDir = "C:/项目 with space";
  fireEvent.change(input, { target: { value: projectDir } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() =>
    expect(mocks.api.openSession).toHaveBeenCalledWith(projectDir, undefined),
  );
});

it("provides visible session actions and a keyboard-navigable menu", async () => {
  await renderBusyApp();
  expect(document.querySelector('button span[role="button"]')).toBeNull();
  const actions = screen.getByRole("button", { name: "会话操作：original" });
  actions.focus();
  fireEvent.click(actions);
  const menu = await screen.findByRole("menu");
  const refresh = screen.getByRole("menuitem", { name: "刷新状态与用量" });
  await waitFor(() => expect(document.activeElement).toBe(refresh));
  fireEvent.keyDown(menu, { key: "ArrowDown" });
  expect(document.activeElement).toBe(
    screen.getByRole("menuitem", { name: "最小化到托盘" }),
  );
  fireEvent.keyDown(menu, { key: "End" });
  expect(document.activeElement).toBe(
    screen.getByRole("menuitem", { name: "删除会话文件" }),
  );
  fireEvent.keyDown(menu, { key: "Home" });
  expect(document.activeElement).toBe(refresh);
  fireEvent.keyDown(menu, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  expect(mocks.api.abort).not.toHaveBeenCalled();
  await waitFor(() => expect(document.activeElement).toBe(actions));
});

it("renames a session in an app dialog and keeps Escape separate from abort", async () => {
  await renderBusyApp();
  const actions = screen.getByRole("button", { name: "会话操作：original" });
  fireEvent.click(actions);
  fireEvent.click(await screen.findByRole("menuitem", { name: "重命名" }));
  let dialog = await screen.findByRole("dialog", { name: "重命名会话" });
  fireEvent.keyDown(dialog, { key: "Escape" });
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "重命名会话" })).toBeNull(),
  );
  expect(mocks.api.abort).not.toHaveBeenCalled();

  fireEvent.click(actions);
  fireEvent.click(await screen.findByRole("menuitem", { name: "重命名" }));
  dialog = await screen.findByRole("dialog", { name: "重命名会话" });
  fireEvent.change(screen.getByRole("textbox", { name: "会话名称" }), {
    target: { value: "renamed" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存名称" }));
  await waitFor(() =>
    expect(mocks.api.setSessionName).toHaveBeenCalledWith("s1", "renamed"),
  );
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "重命名会话" })).toBeNull(),
  );
  expect(screen.getAllByText("renamed").length).toBeGreaterThan(0);
});

it("confirms deletion in an app alert dialog", async () => {
  await renderBusyApp();
  const actions = screen.getByRole("button", { name: "会话操作：original" });
  fireEvent.click(actions);
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "删除会话文件" }),
  );
  let dialog = await screen.findByRole("alertdialog", {
    name: "删除会话文件？",
  });
  expect(dialog.textContent).toContain("C:/sessions/original.jsonl");
  fireEvent.keyDown(dialog, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(mocks.api.deleteSession).not.toHaveBeenCalled();
  expect(mocks.api.abort).not.toHaveBeenCalled();

  fireEvent.click(actions);
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "删除会话文件" }),
  );
  dialog = await screen.findByRole("alertdialog", { name: "删除会话文件？" });
  fireEvent.click(screen.getByRole("button", { name: "删除会话" }));
  await waitFor(() =>
    expect(mocks.api.deleteSession).toHaveBeenCalledWith(
      "C:/sessions/original.jsonl",
    ),
  );
});

it("groups low-frequency toolbar actions into the session menu", async () => {
  await renderBusyApp();
  expect(screen.queryByRole("button", { name: "刷新" })).toBeNull();
  expect(screen.queryByRole("button", { name: "压缩" })).toBeNull();
  expect(screen.queryByRole("button", { name: "托盘" })).toBeNull();
  const dock = screen.getByRole("button", { name: "面板" });
  expect(dock.getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(dock);
  expect(dock.getAttribute("aria-pressed")).toBe("false");
  const tree = screen.getByRole("button", { name: "会话树" });
  expect(tree.getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(tree);
  expect(tree.getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "会话操作：original" }));
  expect(
    await screen.findByRole("menuitem", { name: "压缩上下文" }),
  ).toBeTruthy();
  expect(screen.getByRole("menuitem", { name: "刷新状态与用量" })).toBeTruthy();
});

it("offers a return-to-latest control only after scrolling away", async () => {
  render(
    <Transcript
      items={[{ kind: "user", id: "u1", text: "hello", images: 0 }]}
      busy={false}
    />,
  );
  const element = document.querySelector(".transcript") as HTMLDivElement;
  Object.defineProperties(element, {
    scrollHeight: { value: 1000, configurable: true },
    clientHeight: { value: 300, configurable: true },
    scrollTop: { value: 0, writable: true, configurable: true },
  });
  fireEvent.scroll(element);
  const jump = await screen.findByRole("button", { name: "回到最新消息" });
  fireEvent.click(jump);
  expect(element.scrollTop).toBe(1000);
  expect(screen.queryByRole("button", { name: "回到最新消息" })).toBeNull();
});

it("binds scrolling when an empty transcript receives its first message", async () => {
  const { rerender } = render(<Transcript items={[]} busy={false} />);
  rerender(
    <Transcript
      items={[{ kind: "user", id: "u1", text: "first", images: 0 }]}
      busy={false}
    />,
  );
  const element = document.querySelector(".transcript") as HTMLDivElement;
  Object.defineProperties(element, {
    scrollHeight: { value: 900, configurable: true },
    clientHeight: { value: 300, configurable: true },
    scrollTop: { value: 0, writable: true, configurable: true },
  });
  fireEvent.scroll(element);
  expect(
    await screen.findByRole("button", { name: "回到最新消息" }),
  ).toBeTruthy();
});

it("collapses Bash output until requested", async () => {
  render(
    <Transcript
      items={[
        {
          kind: "bash",
          id: "b1",
          command: "cargo test",
          output: "line 1\nline 2",
          exitCode: 0,
        },
      ]}
      busy={false}
    />,
  );
  expect(screen.queryByText("line 1\nline 2")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /bash/ }));
  expect(document.querySelector(".tool-output")?.textContent).toBe(
    "line 1\nline 2",
  );
});

it("renders extension status, widget, title and notification severity", async () => {
  await renderBusyApp();
  mocks.api.setWindowTitle.mockClear();
  act(() =>
    mocks.events?.({
      sessionId: "s1",
      generation: 1,
      events: [
        {
          kind: "ui",
          event: {
            id: "n1",
            method: "notify",
            options: [],
            message: "Extension warning",
            notifyType: "warning",
          },
        },
        {
          kind: "ui",
          event: {
            id: "s1",
            method: "setStatus",
            options: [],
            statusKey: "build",
            statusText: "Building…",
          },
        },
        {
          kind: "ui",
          event: {
            id: "w1",
            method: "setWidget",
            options: [],
            widgetKey: "progress",
            widgetLines: ["Widget line"],
          },
        },
        {
          kind: "ui",
          event: {
            id: "t1",
            method: "setTitle",
            options: [],
            title: "Custom Pi title",
          },
        },
      ],
    }),
  );
  expect(screen.getByText("Building…")).toBeTruthy();
  expect(screen.getByText("Widget line")).toBeTruthy();
  expect(document.querySelector(".tone-warn .info-card")?.textContent).toBe(
    "Extension warning",
  );
  await waitFor(() =>
    expect(mocks.api.setWindowTitle).toHaveBeenCalledWith("Custom Pi title"),
  );

  act(() =>
    mocks.events?.({
      sessionId: "s1",
      generation: 1,
      events: [
        {
          kind: "ui",
          event: {
            id: "s2",
            method: "setStatus",
            options: [],
            statusKey: "build",
            statusText: "",
          },
        },
        {
          kind: "ui",
          event: {
            id: "w2",
            method: "setWidget",
            options: [],
            widgetKey: "progress",
            widgetLines: [],
          },
        },
        {
          kind: "ui",
          event: { id: "t2", method: "setTitle", options: [], title: "" },
        },
      ],
    }),
  );
  expect(screen.queryByText("Building…")).toBeNull();
  expect(screen.queryByText("Widget line")).toBeNull();
  await waitFor(() =>
    expect(mocks.api.setWindowTitle).toHaveBeenCalledWith("Pi Workbench"),
  );
});

it("clears extension state when a session process is replaced", async () => {
  const { result } = renderHook(() => useSessions());
  await waitFor(() => expect(result.current.settings).not.toBeNull());
  await act(async () => {
    await result.current.openProject("C:/project");
  });
  act(() =>
    mocks.events?.({
      sessionId: "s1",
      generation: 1,
      events: [
        {
          kind: "ui",
          event: {
            id: "s1",
            method: "setStatus",
            options: [],
            statusKey: "build",
            statusText: "Building…",
          },
        },
        {
          kind: "ui",
          event: {
            id: "w1",
            method: "setWidget",
            options: [],
            widgetKey: "progress",
            widgetLines: ["Widget line"],
          },
        },
        {
          kind: "ui",
          event: { id: "t1", method: "setTitle", options: [], title: "Custom" },
        },
      ],
    }),
  );
  expect(result.current.active?.extensionStatuses.build).toBe("Building…");
  act(() =>
    mocks.snapshot?.({ ...base, info: { ...base.info, generation: 2 } }),
  );
  expect(result.current.active?.extensionStatuses).toEqual({});
  expect(result.current.active?.extensionWidgets).toEqual({});
  expect(result.current.active?.windowTitle).toBeUndefined();
});

describe("Markdown actions", () => {
  it("copies a code block", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    render(<Markdown text={"```rust\nfn main() {}\n```"} />);
    fireEvent.click(screen.getByRole("button", { name: "复制代码" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("fn main() {}"));
    expect(screen.getByRole("button", { name: "复制代码" }).textContent).toBe(
      "已复制",
    );
  });

  it("opens http links and does not render script links as links", async () => {
    render(
      <Markdown text={"[Pi](https://pi.dev) and [bad](javascript:alert(1))"} />,
    );
    const link = screen.getByRole("link", { name: "Pi" });
    fireEvent.click(link);
    await waitFor(() =>
      expect(externalMocks.open).toHaveBeenCalledWith("https://pi.dev/"),
    );
    expect(screen.queryByRole("link", { name: "bad" })).toBeNull();
    expect(screen.getByText(/javascript:alert/)).toBeTruthy();
  });
});

type Submit = (text: string, images: Draft["images"]) => Promise<void>;

function ComposerHarness({
  send,
  vision = true,
  busy = false,
  steer = send,
  followUp = send,
  queues = null,
  pendingMessageCount = 0,
  stopping = false,
  onAbort = () => {},
}: {
  send: Submit;
  vision?: boolean;
  busy?: boolean;
  steer?: Submit;
  followUp?: Submit;
  queues?: PiQueues | null;
  pendingMessageCount?: number;
  stopping?: boolean;
  onAbort?: () => void;
}) {
  const [draft, setDraft] = useState<Draft>({ text: "", images: [] });
  return (
    <Composer
      sessionId="s1"
      busy={busy}
      draft={draft}
      queues={queues}
      pendingMessageCount={pendingMessageCount}
      stopping={stopping}
      onDraftChange={setDraft}
      onSend={send}
      onSteer={steer}
      onFollowUp={followUp}
      onAbort={onAbort}
      model={{
        id: "mock",
        provider: "offline",
        input: vision ? ["text", "image"] : ["text"],
      }}
    />
  );
}

describe("attachments", () => {
  it("sends image-only content and clears after acknowledgment", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    render(<ComposerHarness send={send} />);
    const file = new File([new Uint8Array([1, 2, 3])], "image.png", {
      type: "image/png",
    });
    fireEvent.paste(screen.getByRole("textbox"), {
      clipboardData: { files: [file] },
    });
    await screen.findByAltText("attachment 1");
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith("", [
        { type: "image", mimeType: "image/png", data: "AQID" },
      ]),
    );
    await waitFor(() =>
      expect(screen.queryByAltText("attachment 1")).toBeNull(),
    );
  });
  it("preserves text and images after failure", async () => {
    render(
      <ComposerHarness
        send={vi.fn().mockRejectedValue(new Error("offline"))}
      />,
    );
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "keep me" },
    });
    fireEvent.drop(screen.getByRole("textbox").closest(".composer")!, {
      dataTransfer: {
        files: [new File(["abc"], "x.png", { type: "image/png" })],
      },
    });
    await screen.findByAltText("attachment 1");
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await screen.findByRole("alert");
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
      "keep me",
    );
    expect(screen.queryByAltText("attachment 1")).not.toBeNull();
  });
  it("blocks unsupported models without discarding attachments", async () => {
    const send = vi.fn();
    render(<ComposerHarness send={send} vision={false} />);
    fireEvent.paste(screen.getByRole("textbox"), {
      clipboardData: {
        files: [new File(["abc"], "x.png", { type: "image/png" })],
      },
    });
    await screen.findByAltText("attachment 1");
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await screen.findByRole("alert");
    expect(send).not.toHaveBeenCalled();
    expect(screen.queryByAltText("attachment 1")).not.toBeNull();
  });
  it("rejects image and aggregate size limits", () => {
    const image = {
      type: "image" as const,
      mimeType: "image/png",
      data: "AAAA".repeat(Math.ceil(MAX_IMAGE_BYTES / 3)),
    };
    expect(() => validateImages([image])).toThrow();
    const half = {
      ...image,
      data: "AAAA".repeat(Math.floor(MAX_IMAGE_BYTES / 3)),
    };
    expect(() => validateImages([half, half, half])).toThrow();
  });
});

it.each(["select", "confirm", "input", "editor"])(
  "renders and answers %s dialogs",
  (method) => {
    const answer = vi.fn();
    render(
      <ExtensionDialogs
        requests={[{ id: "u1", method, options: ["choice"], title: "dialog" }]}
        onAnswer={answer}
      />,
    );
    if (method === "select")
      fireEvent.click(screen.getByRole("button", { name: "choice" }));
    else if (method === "confirm")
      fireEvent.click(screen.getByRole("button", { name: "确认" }));
    else {
      fireEvent.change(screen.getByRole("textbox"), {
        target: { value: "hello" },
      });
      fireEvent.click(screen.getByRole("button", { name: "提交" }));
    }
    expect(answer).toHaveBeenCalled();
  },
);

it("separates accumulated tokens from current context", () => {
  expect(normalizeStats(base.stats)).toMatchObject({
    totalTokens: 123,
    tokens: 80,
    contextWindow: 10000,
    percent: 0.8,
  });
});
