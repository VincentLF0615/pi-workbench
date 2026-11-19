import { useRef, useState } from "react";
import { open as openDirectory } from "@tauri-apps/plugin-dialog";

import { api } from "../lib/api";
import type { ProjectGroupInfo, SessionFileInfo } from "../lib/types";
import type { SessionRuntime } from "../lib/store";
import piMark from "../assets/pi-mark.png";

/** Left sidebar: projects, their sessions, and the sessions open in this app. */
export function Sidebar({
  projects,
  sessions,
  activeId,
  onSelect,
  onOpen,
  onClose,
  newSessionProjectDir,
  onNewSession,
}: {
  projects: ProjectGroupInfo[];
  sessions: SessionRuntime[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onOpen: (projectDir: string, sessionPath?: string) => void;
  onClose: (id: string) => void;
  newSessionProjectDir: string | null;
  onNewSession: (projectDir: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [adding, setAdding] = useState(false);
  const [newPath, setNewPath] = useState("");
  const [picking, setPicking] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);
  const projectInput = useRef<HTMLInputElement>(null);

  const revealProjectInput = () => {
    setPickError(null);
    setAdding(true);
    window.setTimeout(() => projectInput.current?.focus(), 0);
  };

  const chooseProject = async () => {
    if (picking) return;
    setPicking(true);
    setPickError(null);
    try {
      const selected = await openDirectory({
        directory: true,
        multiple: false,
        title: "选择 Pi 项目目录",
        defaultPath: newSessionProjectDir ?? undefined,
      });
      if (typeof selected === "string" && selected.trim()) {
        setAdding(false);
        setNewPath("");
        onOpen(selected);
      }
    } catch (cause) {
      setPickError(`目录选择器不可用：${String(cause)}。请手动输入路径。`);
      setAdding(true);
      window.setTimeout(() => projectInput.current?.focus(), 0);
    } finally {
      setPicking(false);
    }
  };

  const filtered = projects
    .map((group) => ({
      ...group,
      sessions: group.sessions.filter(
        (session) =>
          !query.trim() ||
          session.preview.toLowerCase().includes(query.toLowerCase()) ||
          group.cwd.toLowerCase().includes(query.toLowerCase()),
      ),
    }))
    .filter((group) => group.sessions.length > 0 || !query.trim());

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <img src={piMark} alt="" />
        <div>
          <strong>Pi Workbench</strong>
          <small>你的编程工作台</small>
        </div>
      </div>
      <div className="sidebar-top">
        <button
          type="button"
          className="btn primary block"
          onClick={() => {
            if (newSessionProjectDir) onNewSession(newSessionProjectDir);
            else void chooseProject();
          }}
          disabled={picking}
        >
          新会话
        </button>
        <button
          type="button"
          className="btn ghost block"
          onClick={() => void chooseProject()}
          disabled={picking}
        >
          {picking ? "选择中…" : "打开项目…"}
        </button>
      </div>
      {!adding && (
        <button
          type="button"
          className="link-button sidebar-manual"
          onClick={revealProjectInput}
          disabled={picking}
        >
          手动输入路径
        </button>
      )}

      {adding && (
        <div className="sidebar-add">
          {pickError && (
            <div className="sidebar-error" role="alert">
              {pickError}
            </div>
          )}
          <input
            ref={projectInput}
            className="input"
            placeholder="项目目录，例如 E:\project"
            value={newPath}
            onChange={(event) => setNewPath(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && newPath.trim()) {
                onOpen(newPath.trim());
                setAdding(false);
                setNewPath("");
              }
            }}
            autoFocus
          />
          <button
            type="button"
            className="btn secondary"
            onClick={() => {
              if (newPath.trim()) {
                onOpen(newPath.trim());
                setAdding(false);
                setNewPath("");
              }
            }}
          >
            打开
          </button>
        </div>
      )}

      <input
        className="input search"
        placeholder="搜索会话…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />

      <div className="sidebar-scroll">
        {sessions.length > 0 && (
          <Section title="已打开" count={sessions.length}>
            {sessions.map((runtime) => (
              <div
                key={runtime.info.id}
                className={`session-row ${runtime.info.id === activeId ? "active" : ""}`}
              >
                <button
                  type="button"
                  className="session-select"
                  onClick={() => onSelect(runtime.info.id)}
                  title={runtime.info.projectDir}
                  aria-current={
                    runtime.info.id === activeId ? "page" : undefined
                  }
                >
                  <span
                    className={`session-dot ${runtime.busy ? "busy" : ""}`}
                  />
                  <span className="session-label">{runtime.info.label}</span>
                  {runtime.info.closed && (
                    <span className="session-flag">已断开</span>
                  )}
                </button>
                <button
                  type="button"
                  className="session-close"
                  onClick={() => onClose(runtime.info.id)}
                  title="关闭会话"
                  aria-label={`关闭会话：${runtime.info.label}`}
                >
                  ×
                </button>
              </div>
            ))}
          </Section>
        )}

        {filtered.length === 0 && (
          <div className="sidebar-empty">
            {query.trim() ? "没有匹配的会话" : "还没有历史会话"}
          </div>
        )}

        {filtered.map((group) => {
          const isOpen = expanded[group.cwd] ?? group.sessions.length <= 6;
          return (
            <Section
              key={group.cwd}
              title={group.cwd}
              count={group.sessions.length}
              collapsible
              open={isOpen}
              onToggle={() =>
                setExpanded((current) => ({ ...current, [group.cwd]: !isOpen }))
              }
            >
              {isOpen &&
                group.sessions.map((session) => (
                  <SessionRow
                    key={session.path}
                    session={session}
                    onOpen={() => onOpen(group.cwd, session.path)}
                  />
                ))}
            </Section>
          );
        })}
      </div>
    </aside>
  );
}

function Section({
  title,
  count,
  children,
  collapsible,
  open,
  onToggle,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
  collapsible?: boolean;
  open?: boolean;
  onToggle?: () => void;
}) {
  return (
    <div className="sidebar-section">
      <div className="sidebar-section-head">
        {collapsible ? (
          <button
            type="button"
            className="sidebar-section-title"
            onClick={onToggle}
            aria-expanded={open}
          >
            <span className="caret">{open ? "▾" : "▸"}</span>
            <span className="truncate" title={title}>
              {title}
            </span>
            <span className="count">{count}</span>
          </button>
        ) : (
          <div className="sidebar-section-title">
            <span className="truncate" title={title}>
              {title}
            </span>
            <span className="count">{count}</span>
          </div>
        )}
      </div>
      {children}
    </div>
  );
}

function SessionRow({
  session,
  onOpen,
}: {
  session: SessionFileInfo;
  onOpen: () => void;
}) {
  const date = new Date(session.modifiedAt);
  const when = Number.isFinite(date.getTime()) ? formatWhen(date) : "";
  return (
    <button
      type="button"
      className="session-row file"
      onClick={onOpen}
      title={session.path}
    >
      <span className="session-label truncate">
        {session.preview || "（空会话）"}
      </span>
      <span className="session-meta">
        {session.messageCount > 0 && <span>{session.messageCount} 条</span>}
        {when && <span>{when}</span>}
      </span>
    </button>
  );
}

function formatWhen(date: Date): string {
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) {
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  }
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

export { api };
