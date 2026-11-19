import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { api } from "../lib/api";
import type { FileNode, GitFile, GitStatus, TextFile } from "../lib/types";

/** Which panel the right dock is showing. */
export type DockTab = "files" | "changes" | "preview" | "logs";

/**
 * The right-hand workbench dock: file tree, git changes, file preview and
 * pi's stderr log. Each tab loads on demand and caches its result.
 */
export function Dock({
  projectDir,
  sessionId,
  tab,
  onTab,
  onReveal,
  widgets,
}: {
  projectDir: string | null;
  sessionId: string | null;
  tab: DockTab;
  onTab: (tab: DockTab) => void;
  onReveal: (path: string) => void;
  widgets: Record<string, string[]>;
}) {
  const [git, setGit] = useState<GitStatus | null>(null);
  const [files, setFiles] = useState<FileNode[] | null>(null);
  const [logs, setLogs] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (which: DockTab) => {
      if (!projectDir && which !== "logs") return;
      setError(null);
      try {
        if (which === "changes") {
          const status = await api.gitStatus(projectDir!);
          setGit(status);
        } else if (which === "files") {
          const nodes = await api.listFiles(projectDir!, null, 2);
          setFiles(nodes);
        } else if (which === "logs" && sessionId) {
          const result = await api.sessionLogs(sessionId);
          setLogs(result.lines ?? []);
        }
      } catch (cause) {
        setError(String(cause));
      }
    },
    [projectDir, sessionId],
  );

  // Load whenever the tab or project changes.
  useEffect(() => {
    void load(tab);
  }, [load, tab]);

  const counts = useMemo(() => {
    const changed = git?.files.length ?? 0;
    return { changed };
  }, [git]);

  return (
    <aside className="dock">
      <div className="dock-tabs">
        <DockButton active={tab === "files"} onClick={() => onTab("files")} title="项目文件">
          文件
        </DockButton>
        <DockButton
          active={tab === "changes"}
          onClick={() => onTab("changes")}
          title="Git 改动"
          badge={counts.changed || undefined}
        >
          改动
        </DockButton>
        <DockButton active={tab === "preview"} onClick={() => onTab("preview")} title="文件预览">
          预览
        </DockButton>
        <DockButton
          active={tab === "logs"}
          onClick={() => onTab("logs")}
          onClickReload={() => void load("logs")}
          title="pi 日志"
        >
          日志
        </DockButton>
      </div>

      {error && <div className="dock-error">{error}</div>}

      <div className="dock-body">
        {tab === "files" && <FileTree nodes={files} onOpen={onReveal} onPick={onReveal} />}
        {tab === "changes" && (
          <ChangesPanel
            git={git}
            projectDir={projectDir}
            onOpen={(path) => {
              onReveal(path);
              onTab("preview");
            }}
          />
        )}
        {tab === "preview" && <PreviewPane />}
        {tab === "logs" && <LogPane lines={logs} />}
      </div>
      <ExtensionWidgets widgets={widgets} />
    </aside>
  );
}

export function ExtensionWidgets({
  widgets,
}: {
  widgets: Record<string, string[]>;
}) {
  const entries = Object.entries(widgets).filter(([, lines]) => lines.length > 0);
  if (entries.length === 0) return null;
  return (
    <section className="extension-widgets" aria-label="扩展组件">
      <div className="extension-widgets-title">扩展</div>
      {entries.map(([key, lines]) => (
        <div className="extension-widget" key={key} title={`扩展：${key}`}>
          {lines.map((line, index) => (
            <div className="extension-widget-line" key={`${index}:${line}`}>
              {line}
            </div>
          ))}
        </div>
      ))}
    </section>
  );
}

function DockButton({
  active,
  onClick,
  onClickReload,
  badge,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  onClickReload?: () => void;
  badge?: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`dock-tab ${active ? "active" : ""}`}>
      <button type="button" onClick={onClick} title={title} aria-pressed={active}>
        {children}
        {badge != null && badge > 0 && <span className="dock-badge">{badge}</span>}
      </button>
      {onClickReload && (
        <button
          type="button"
          className="dock-reload"
          onClick={onClickReload}
          title="刷新"
        >
          ⟳
        </button>
      )}
    </div>
  );
}

/** File tree with expandable directories. */
export function FileTree({
  nodes,
  onOpen,
  onPick,
  depth = 0,
}: {
  nodes: FileNode[] | null;
  onOpen: (path: string) => void;
  onPick: (path: string) => void;
  depth?: number;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [children, setChildren] = useState<Record<string, FileNode[]>>({});

  const toggle = useCallback(
    async (node: FileNode) => {
      setExpanded((current) => {
        const next = new Set(current);
        if (next.has(node.path)) {
          next.delete(node.path);
        } else {
          next.add(node.path);
        }
        return next;
      });
      if (!children[node.path] && node.is_dir) {
        try {
          const loaded = await api.listFiles(node.path, null, 1);
          setChildren((current) => ({ ...current, [node.path]: loaded }));
        } catch {
          // A directory we cannot read simply stays collapsed.
        }
      }
    },
    [children],
  );

  if (nodes === null) return <div className="dock-empty">正在加载…</div>;
  if (nodes.length === 0) return <div className="dock-empty">没有文件</div>;

  return (
    <div className="file-tree" style={{ paddingLeft: depth * 12 }}>
      {nodes.map((node) => {
        const isOpen = expanded.has(node.path);
        return (
          <div key={node.path}>
            <div
              className={`file-row ${node.is_dir ? "dir" : ""}`}
              onClick={() => (node.is_dir ? void toggle(node) : onPick(node.path))}
              onDoubleClick={() => !node.is_dir && onOpen(node.path)}
              title={node.path}
            >
              <span className="file-caret">
                {node.is_dir ? (isOpen ? "▾" : "▸") : "·"}
              </span>
              <span className="file-name">{node.name}</span>
            </div>
            {node.is_dir && isOpen && (
              <FileTree
                nodes={children[node.path] ?? []}
                onOpen={onOpen}
                onPick={onPick}
                depth={depth + 1}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Git changes panel. */
export function ChangesPanel({
  git,
  projectDir,
  onOpen,
}: {
  git: GitStatus | null;
  projectDir: string | null;
  onOpen: (path: string) => void;
}) {
  const [diff, setDiff] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  if (git === null) return <div className="dock-empty">正在加载…</div>;
  if (!git.is_repo) {
    return <div className="dock-empty">{git.error ?? "不是 git 仓库"}</div>;
  }

  const show = async (file: GitFile) => {
    setSelected(file.path);
    setDiff(null);
    if (!projectDir) return;
    try {
      const text = await api.gitDiff(projectDir, file.path);
      setDiff(text);
    } catch (cause) {
      setDiff(String(cause));
    }
  };

  return (
    <div className="changes">
      <div className="changes-head">
        <span className="changes-branch">{git.branch ?? "detached"}</span>
        <span className="changes-count">{git.files.length} 个改动</span>
      </div>
      <div className="changes-list">
        {git.files.length === 0 && <div className="dock-empty">工作区干净</div>}
        {git.files.map((file) => (
          <div
            key={file.path}
            className={`change-row ${selected === file.path ? "active" : ""}`}
            onClick={() => void show(file)}
            onDoubleClick={() => onOpen(file.path)}
            title={file.path}
          >
            <span className={`change-status st-${file.status}`}>{file.status}</span>
            <span className="change-path">{file.path}</span>
            {file.old_path && <span className="change-old">← {file.old_path}</span>}
          </div>
        ))}
      </div>
      {selected && (
        <div className="changes-diff">
          <div className="changes-diff-head">{selected}</div>
          <pre>{diff ?? "加载中…"}</pre>
        </div>
      )}
    </div>
  );
}
/** File preview pane. */
export function PreviewPane() {
  const [path, setPath] = useState<string | null>(null);
  const [file, setFile] = useState<TextFile | null>(null);
  const [language, setLanguage] = useState<string>("text");
  const [error, setError] = useState<string | null>(null);

  // The dock's "reveal" sets the path; listen for it through a custom event.
  useEffect(() => {
    const onReveal = (event: Event) => {
      const detail = (event as CustomEvent<{ path: string }>).detail;
      if (detail?.path) {
        setPath(detail.path);
        void load(detail.path);
      }
    };
    window.addEventListener("pi-workbench:reveal", onReveal);
    return () => window.removeEventListener("pi-workbench:reveal", onReveal);
  }, []);

  const load = async (target: string) => {
    setError(null);
    setFile(null);
    try {
      const [loaded, lang] = await Promise.all([
        api.readTextFile(target),
        api.fileLanguage(target),
      ]);
      setFile(loaded);
      setLanguage(lang);
    } catch (cause) {
      setError(String(cause));
    }
  };

  if (!path) {
    return <div className="dock-empty">在文件树或工具卡片里选择文件</div>;
  }
  if (error) return <div className="dock-error">{error}</div>;
  if (!file) return <div className="dock-empty">正在加载…</div>;

  return (
    <div className="preview">
      <div className="preview-head">
        <span className="preview-path" title={file.path}>
          {file.path.split(/[\\/]/).pop()}
        </span>
        <span className="preview-lang">{language}</span>
        {file.truncated && (
          <span className="preview-truncated">
            已截断（共 {(file.total_bytes / 1024).toFixed(0)} KB）
          </span>
        )}
      </div>
      <pre className="preview-code">{file.text}</pre>
    </div>
  );
}

/** pi's stderr log. */
export function LogPane({ lines }: { lines: string[] | null }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines]);

  if (lines === null) return <div className="dock-empty">正在加载…</div>;
  if (lines.length === 0) return <div className="dock-empty">pi 还没有输出日志</div>;

  return (
    <div className="logs" ref={ref}>
      {lines.map((line, index) => (
        <div key={index} className="log-line">
          {line}
        </div>
      ))}
    </div>
  );
}
