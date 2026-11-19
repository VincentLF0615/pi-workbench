import { useCallback, useEffect, useState } from "react";

import { useSessions, projectDirFor } from "./lib/store";
import { Sidebar } from "./components/Sidebar";
import { Transcript, formatTokens } from "./components/Transcript";
import { Composer, ContextRing, ExtensionDialogs } from "./components/Composer";
import { ModelPicker } from "./components/ModelPicker";
import { Dock, type DockTab } from "./components/Dock";
import {
  CommandPalette,
  ConfirmDialog,
  ForkDialog,
  Menu,
  RenameDialog,
  type MenuItem,
  SessionTreePanel,
  SettingsDialog,
} from "./components/Panels";
import { api, onOpenRequest } from "./lib/api";

/** Ask the preview pane to open a file. */
function reveal(path: string) {
  window.dispatchEvent(
    new CustomEvent("pi-workbench:reveal", { detail: { path } }),
  );
}

/** The whole app: sidebar + session tabs + transcript + composer. */
export default function App() {
  const store = useSessions();
  const { active, sessions, activeId, install, loading, error, compatibility } =
    store;

  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    sessionId: string;
  } | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [forkOpen, setForkOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deletePath, setDeletePath] = useState<string | null>(null);
  const [forkMessages, setForkMessages] = useState<
    { entryId: string; text: string }[] | null
  >(null);
  const [treeOpen, setTreeOpen] = useState(false);
  const [dockOpen, setDockOpen] = useState(true);
  const [dockTab, setDockTab] = useState<DockTab>("files");

  // Ctrl/Cmd+K opens the command palette, Ctrl+B toggles the right dock.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => {
          if (!open) void store.loadCommands();
          return !open;
        });
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "b") {
        event.preventDefault();
        setDockOpen((open) => !open);
      }
      if (
        event.key === "Escape" &&
        !event.defaultPrevented &&
        !menu &&
        !paletteOpen &&
        !settingsOpen &&
        !forkOpen &&
        !renameOpen &&
        !deletePath &&
        active?.busy &&
        !active.stopping
      ) {
        if (
          event.target instanceof HTMLElement &&
          event.target.closest('[aria-modal="true"], [role="menu"]')
        ) {
          return;
        }
        event.preventDefault();
        void store.abort();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [store]);

  const loadTree = store.loadTree;
  // Load the tree when its panel opens.
  useEffect(() => {
    if (treeOpen) void loadTree();
  }, [treeOpen, loadTree]);

  // A second launch forwards its arguments here; open them immediately.
  //
  // Rust emits through Tauri's event system, so this must use a Tauri listener:
  // `window.addEventListener` only sees events dispatched inside the webview.
  useEffect(() => {
    return onOpenRequest(() => {
      void (async () => {
        const intent = await api.takeStartupIntent();
        if (intent?.session_path) {
          const dir = projectDirFor(intent.session_path, store.projects);
          if (dir) await store.openProject(dir, intent.session_path);
          return;
        }
        if (intent?.project_dir) {
          await store.openProject(intent.project_dir);
        }
      })().catch((cause) =>
        console.error("Unable to open launch request", cause),
      );
    });
  }, [store.openProject, store.projects]);

  // Remember the last project so a restart can offer it again.
  useEffect(() => {
    if (
      active?.info.projectDir &&
      store.settings?.lastProject !== active.info.projectDir
    ) {
      void store.updateSettings({ lastProject: active.info.projectDir });
    }
  }, [
    active?.info.projectDir,
    store.settings?.lastProject,
    store.updateSettings,
  ]);

  useEffect(() => {
    const title = active?.windowTitle?.trim() || "Pi Workbench";
    void api
      .setWindowTitle(title)
      .catch((cause) => console.error("Unable to set window title", cause));
  }, [active?.info.id, active?.windowTitle]);

  const runCommand = useCallback(
    (name: string) => {
      if (!activeId) return;
      // Slash commands are sent as a normal prompt, prefixed with `/`.
      void api.sendPrompt(activeId, `/${name}`);
    },
    [activeId],
  );

  const openFork = useCallback(async () => {
    if (!activeId) return;
    setForkOpen(true);
    setForkMessages(null);
    try {
      const result = await api.getForkMessages(activeId);
      setForkMessages(result.messages ?? []);
    } catch {
      setForkMessages([]);
    }
  }, [activeId]);

  const openSessionMenu = (sessionId: string, x: number, y: number) => {
    store.setActiveId(sessionId);
    setMenu({ x, y, sessionId });
  };

  const menuItems: MenuItem[] = activeId
    ? [
        {
          label: "刷新状态与用量",
          onSelect: () => void store.refreshState(),
        },
        {
          label: "最小化到托盘",
          onSelect: () => {
            void api
              .minimizeToTray()
              .catch((cause) =>
                console.error("Unable to minimize to tray", cause),
              );
          },
        },
        { kind: "separator" },
        {
          label: "重命名",
          onSelect: () => setRenameOpen(true),
        },
        { label: "从这里分叉…", onSelect: () => void openFork() },
        { label: "克隆为新会话", onSelect: () => void store.clone() },
        { kind: "separator" },
        {
          label: "压缩上下文",
          onSelect: () => void store.compact(),
        },
        {
          label: "导出 HTML",
          onSelect: () => {
            void api.exportHtml(activeId).then((result) => {
              if (result?.path) void openPath(result.path);
            });
          },
        },
        { kind: "separator" },
        {
          label: "删除会话文件",
          tone: "danger",
          disabled: !active?.info.sessionPath,
          hint: active?.info.sessionPath ? undefined : "尚未保存",
          onSelect: () => {
            const path = active?.info.sessionPath;
            if (path) setDeletePath(path);
          },
        },
      ]
    : [];

  const extensionStatuses = active
    ? Object.values(active.extensionStatuses).filter((text) => text.trim())
    : [];

  return (
    <div
      className="app"
      style={{
        gridTemplateColumns: `${store.settings?.sidebarWidth ?? 300}px 1fr`,
      }}
    >
      <Sidebar
        projects={store.projects}
        sessions={sessions}
        activeId={activeId}
        onSelect={store.setActiveId}
        onOpen={(projectDir, sessionPath) =>
          void store.openProject(projectDir, sessionPath)
        }
        onClose={(id) => void store.closeSession(id)}
        newSessionProjectDir={
          active?.info.projectDir ??
          sessions[sessions.length - 1]?.info.projectDir ??
          store.settings?.lastProject ??
          null
        }
        onNewSession={(projectDir) => void store.openProject(projectDir)}
      />

      <main className="main">
        {!install?.found && !loading && (
          <div className="banner warn">
            没有找到 pi：{install?.error ?? "未知原因"}。请先安装 pi
            并登录，或在项目目录里运行
            <code>pi auth login</code>。
          </div>
        )}
        {error && <div className="banner error">{error}</div>}
        {compatibility && compatibility.level !== "ok" && (
          <div
            className={`banner ${compatibility.level === "unknown" ? "warn" : "warn"}`}
          >
            {compatibility.message}
            {compatibility.level !== "unknown" && (
              <>
                {" · "}
                <button
                  type="button"
                  className="link-button"
                  onClick={() => setSettingsOpen(true)}
                >
                  查看设置
                </button>
              </>
            )}
          </div>
        )}

        {sessions.length > 0 && (
          <div className="tabs">
            {sessions.map((runtime) => (
              <div
                key={runtime.info.id}
                className={`tab ${runtime.info.id === activeId ? "active" : ""}`}
                onContextMenu={(event) => {
                  event.preventDefault();
                  openSessionMenu(
                    runtime.info.id,
                    event.clientX,
                    event.clientY,
                  );
                }}
              >
                <button
                  type="button"
                  className="tab-select"
                  onClick={() => store.setActiveId(runtime.info.id)}
                  title={runtime.info.projectDir}
                  aria-current={
                    runtime.info.id === activeId ? "page" : undefined
                  }
                >
                  <span className={`tab-dot ${runtime.busy ? "busy" : ""}`} />
                  <span className="tab-label">{runtime.info.label}</span>
                </button>
                <button
                  type="button"
                  className="tab-action"
                  aria-label={`会话操作：${runtime.info.label}`}
                  aria-haspopup="menu"
                  title="会话操作"
                  onClick={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    openSessionMenu(runtime.info.id, rect.right, rect.bottom);
                  }}
                >
                  ⋯
                </button>
                <button
                  type="button"
                  className="session-close"
                  aria-label={`关闭会话：${runtime.info.label}`}
                  onClick={() => void store.closeSession(runtime.info.id)}
                  title="关闭会话"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        {active ? (
          <>
            <header className="toolbar">
              <div className="toolbar-left">
                <ModelPicker
                  sessionId={active.info.id}
                  busy={active.busy}
                  model={active.state?.model}
                  thinkingLevel={active.state?.thinkingLevel}
                  onApply={store.configureModel}
                />
                <ContextRing
                  percent={active.stats?.percent}
                  tokens={active.stats?.tokens}
                  contextWindow={active.stats?.contextWindow}
                />
                {active.stats?.cost != null && (
                  <span className="toolbar-cost" title="本次会话累计费用">
                    ${active.stats.cost.toFixed(4)}
                  </span>
                )}
              </div>
              <div className="toolbar-right">
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => {
                    setPaletteOpen(true);
                    void store.loadCommands();
                  }}
                  title="命令面板（Ctrl+K）"
                >
                  命令
                </button>
                <button
                  type="button"
                  className={`btn ghost ${treeOpen ? "active" : ""}`}
                  onClick={() => setTreeOpen(!treeOpen)}
                  aria-pressed={treeOpen}
                  title="会话树"
                >
                  会话树
                </button>
                <button
                  type="button"
                  className={`btn ghost ${dockOpen ? "active" : ""}`}
                  onClick={() => setDockOpen(!dockOpen)}
                  aria-pressed={dockOpen}
                  title="右侧工作台（Ctrl+B）"
                >
                  面板
                </button>
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => setSettingsOpen(true)}
                  title="设置"
                >
                  设置
                </button>
              </div>
            </header>

            <div className="body">
              <div className="body-main">
                <Transcript
                  key={active.info.id}
                  items={active.transcript}
                  busy={active.busy}
                  expandTools={store.settings?.expandTools ?? false}
                />
                {treeOpen && (
                  <SessionTreePanel
                    tree={active.tree}
                    onFork={(entryId) => void store.fork(entryId)}
                    onClose={() => setTreeOpen(false)}
                  />
                )}
                <ExtensionDialogs
                  requests={active.uiRequests}
                  onAnswer={(requestId, reply) =>
                    store.answerUi(requestId, reply)
                  }
                />
              </div>
              {dockOpen && (
                <Dock
                  projectDir={active.info.projectDir}
                  sessionId={active.info.id}
                  widgets={active.extensionWidgets}
                  tab={dockTab}
                  onTab={setDockTab}
                  onReveal={(path) => {
                    reveal(path);
                    setDockTab("preview");
                  }}
                />
              )}
            </div>

            <Composer
              key={active.info.id}
              sessionId={active.info.id}
              busy={active.busy}
              disabled={active.info.closed || !active.state}
              model={active.state?.model}
              draft={active.draft}
              queues={active.queues}
              pendingMessageCount={active.state?.pendingMessageCount}
              stopping={active.stopping}
              onDraftChange={(draft) => store.setDraft(active.info.id, draft)}
              onSend={store.send}
              onSteer={store.steer}
              onFollowUp={store.followUp}
              onAbort={() => void store.abort()}
            />

            {active.stats?.totalTokens != null && (
              <footer
                className="statusbar"
                title={`pid ${active.info.pid} · ${active.info.launchSource}${
                  active.state?.sessionFile
                    ? `\n${active.state.sessionFile}`
                    : ""
                }`}
              >
                <span className="status-project">{active.info.projectDir}</span>
                {extensionStatuses.length > 0 && (
                  <span
                    className="status-extension"
                    title={extensionStatuses.join("\n")}
                  >
                    {extensionStatuses[0]}
                    {extensionStatuses.length > 1
                      ? ` +${extensionStatuses.length - 1}`
                      : ""}
                  </span>
                )}
                <span className="status-tokens">
                  tokens {formatTokens(active.stats.totalTokens!)}
                  {active.stats.contextWindow
                    ? ` / ${formatTokens(active.stats.contextWindow)}`
                    : ""}
                </span>
              </footer>
            )}
          </>
        ) : (
          <div className="placeholder">
            {loading ? (
              <p>正在加载…</p>
            ) : (
              <>
                <h1>Pi Workbench</h1>
                <p>
                  {install?.found
                    ? `已就绪：pi ${install.version ?? ""}`
                    : "未检测到 pi"}
                </p>
                <p className="muted">
                  在左侧选择项目开始，或点「打开项目」输入目录。
                </p>
                <p className="muted">
                  Ctrl+K 打开命令面板 · 标签页「⋯」或右键打开会话操作
                </p>
              </>
            )}
          </div>
        )}

        <Menu anchor={menu} items={menuItems} onClose={() => setMenu(null)} />

        <CommandPalette
          open={paletteOpen}
          commands={active?.commands ?? null}
          busy={active?.busy ?? false}
          onRun={runCommand}
          onClose={() => setPaletteOpen(false)}
        />

        <ForkDialog
          open={forkOpen}
          messages={forkMessages}
          onPick={(entryId) => void store.fork(entryId)}
          onClose={() => setForkOpen(false)}
        />

        <SettingsDialog
          open={settingsOpen}
          settings={
            store.settings ?? {
              theme: "light",
              fontSize: 14,
              fontFamily: "",
              sidebarWidth: 300,
              expandTools: false,
              logLevel: "info",
              minimizeToTray: true,
            }
          }
          settingsPath={store.settingsPath}
          onChange={(patch) => void store.updateSettings(patch)}
          onClose={() => setSettingsOpen(false)}
        />

        <RenameDialog
          open={renameOpen}
          current={active?.info.label ?? ""}
          onSubmit={async (name) => {
            await store.rename(name);
          }}
          onClose={() => setRenameOpen(false)}
        />

        <ConfirmDialog
          open={deletePath !== null}
          title="删除会话文件？"
          message={`此操作会关闭对应会话，并将文件移到回收站（若系统支持）。\n${deletePath ?? ""}`}
          confirmLabel="删除会话"
          pendingLabel="正在删除…"
          danger
          onConfirm={async () => {
            if (deletePath) await store.deleteSession(deletePath);
          }}
          onClose={() => setDeletePath(null)}
        />

        {sessions.flatMap((runtime) =>
          runtime.toasts.map((toast) => (
            <div key={`${runtime.info.id}-${toast.id}`} className="toast">
              {toast.message}
              <button
                type="button"
                className="toast-close"
                onClick={() => store.dismissToast(toast.id)}
              >
                ×
              </button>
            </div>
          )),
        )}
      </main>
    </div>
  );
}

/** Ask the OS to open an exported file. */
async function openPath(path: string) {
  try {
    const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
    revealItemInDir(path);
  } catch {
    // The opener plugin is optional; ignore failures.
  }
}
