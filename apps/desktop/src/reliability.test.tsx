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
  SessionInfo,
  SessionSnapshot,
  Settings,
  UiReply,
} from "./lib/types";
import contracts from "../../../fixtures/contracts/ui-replies.json";

const mocks = vi.hoisted(() => ({
  events: undefined as undefined | ((batch: PiBatch) => void),
  opened: undefined as undefined | ((info: SessionInfo) => void),
  snapshot: undefined as undefined | ((snapshot: SessionSnapshot) => void),
  api: {
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
    listFiles: vi.fn(),
    getSessionSnapshot: vi.fn(),
    sendPrompt: vi.fn(),
    steer: vi.fn(),
    answerUi: vi.fn(),
    forkSession: vi.fn(),
    cloneSession: vi.fn(),
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
  mocks.api.listFiles.mockResolvedValue([]);
  mocks.api.getSessionSnapshot.mockResolvedValue(base);
  mocks.api.sendPrompt.mockResolvedValue({});
  mocks.api.steer.mockResolvedValue({});
  mocks.api.answerUi.mockResolvedValue(undefined);
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

it("opening the session tree does not create a request loop", async () => {
  mocks.api.getSettings.mockResolvedValue({
    ...settings,
    lastProject: "C:/project",
  });
  render(<App />);
  await screen.findByRole("button", { name: "树" });
  fireEvent.click(screen.getByRole("button", { name: "树" }));
  await waitFor(() => expect(mocks.api.getTree).toHaveBeenCalledTimes(1));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 80));
  });
  expect(mocks.api.getTree).toHaveBeenCalledTimes(1);
});

function ComposerHarness({
  send,
  vision = true,
}: {
  send: (text: string, images: Draft["images"]) => Promise<void>;
  vision?: boolean;
}) {
  const [draft, setDraft] = useState<Draft>({ text: "", images: [] });
  return (
    <Composer
      sessionId="s1"
      busy={false}
      draft={draft}
      onDraftChange={setDraft}
      onSend={send}
      onSteer={send}
      onAbort={() => {}}
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
