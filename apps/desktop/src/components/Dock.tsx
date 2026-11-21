import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { api } from "../lib/api";
import { copyText } from "../lib/clipboard";
import type { FileNode, GitFile, GitStatus, TextFile } from "../lib/types";
import {
  IconCheck,
  IconCopy,
  IconExternal,
  IconRefresh,
  IconWrap,
} from "./Icons";

/** Which panel the right dock is showing. */
export type DockTab = "files" | "changes" | "preview" | "logs";
export interface PreviewRequest {
  path: string;
  requestId: number;
}

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
  previewRequest,
  widgets,
  width,
  refreshTick = 0,
}: {
  projectDir: string | null;
  sessionId: string | null;
  tab: DockTab;
  onTab: (tab: DockTab) => void;
  onReveal: (path: string) => void;
  previewRequest: PreviewRequest | null;
  widgets: Record<string, string[]>;
  width?: number;
  refreshTick?: number;
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
          const nodes = await api.listFiles(projectDir!, null, 1);
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

  // Refresh git badge passively after turns settle so the count stays accurate.
  useEffect(() => {
    if (!projectDir || refreshTick === 0) return;
    let alive = true;
    void api
      .gitStatus(projectDir)
      .then((status) => {
        if (alive) setGit(status);
      })
      .catch(() => {
        // Non-repo or transient git error is ignored during background refresh.
      });
    return () => {
      alive = false;
    };
  }, [projectDir, refreshTick]);

  const counts = useMemo(() => {
    const changed = git?.files.length ?? 0;
    return { changed };
  }, [git]);

  return (
    <aside className="dock" style={width ? { width } : undefined}>
      <div className="dock-tabs">
        <DockButton
          active={tab === "files"}
          onClick={() => onTab("files")}
          onClickReload={tab === "files" ? () => void load("files") : undefined}
          reloadLabel="刷新文件"
          title="项目文件"
        >
          文件
        </DockButton>
        <DockButton
          active={tab === "changes"}
          onClick={() => onTab("changes")}
          onClickReload={
            tab === "changes" ? () => void load("changes") : undefined
          }
          reloadLabel="刷新改动"
          title="Git 改动"
          badge={counts.changed || undefined}
        >
          改动
        </DockButton>
        <DockButton
          active={tab === "preview"}
          onClick={() => onTab("preview")}
          title="文件预览"
        >
          预览
        </DockButton>
        <DockButton
          active={tab === "logs"}
          onClick={() => onTab("logs")}
          onClickReload={() => void load("logs")}
          reloadLabel="刷新日志"
          title="pi 日志"
        >
          日志
        </DockButton>
      </div>

      {error && <div className="dock-error">{error}</div>}

      <div className="dock-body">
        {tab === "files" && (
          <FileTree nodes={files} onOpen={onReveal} onPick={onReveal} />
        )}
        {tab === "changes" && (
          <ChangesPanel git={git} projectDir={projectDir} onOpen={onReveal} />
        )}
        {tab === "preview" && <PreviewPane request={previewRequest} />}
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
  const entries = Object.entries(widgets).filter(
    ([, lines]) => lines.length > 0,
  );
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
  reloadLabel = "刷新当前面板",
  badge,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  onClickReload?: () => void;
  reloadLabel?: string;
  badge?: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`dock-tab ${active ? "active" : ""}`}>
      <button
        type="button"
        onClick={onClick}
        title={title}
        aria-pressed={active}
      >
        {children}
        {badge != null && badge > 0 && (
          <span className="dock-badge">{badge}</span>
        )}
      </button>
      {onClickReload && (
        <button
          type="button"
          className="dock-reload"
          onClick={onClickReload}
          title={reloadLabel}
          aria-label={reloadLabel}
        >
          <IconRefresh size={12} />
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
              onClick={() =>
                node.is_dir ? void toggle(node) : onPick(node.path)
              }
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

function diffLineClass(line: string): string {
  if (line.startsWith("@@")) return "diff-line diff-hunk";
  if (
    line.startsWith("diff --git") ||
    line.startsWith("index ") ||
    line.startsWith("--- ") ||
    line.startsWith("+++ ")
  ) {
    return "diff-line diff-meta";
  }
  if (line.startsWith("+")) return "diff-line diff-add";
  if (line.startsWith("-")) return "diff-line diff-del";
  return "diff-line";
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

  const diffLines =
    diff !== null ? diff.replace(/\r\n/g, "\n").split("\n") : null;

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
            <span className={`change-status st-${file.status}`}>
              {file.status}
            </span>
            <span className="change-path">{file.path}</span>
            {file.old_path && (
              <span className="change-old">← {file.old_path}</span>
            )}
          </div>
        ))}
      </div>
      {selected && (
        <div className="changes-diff">
          <div className="changes-diff-head">
            <span className="truncate" title={selected}>
              {selected}
            </span>
            <button
              type="button"
              className="dock-icon-btn"
              title="在预览中打开"
              aria-label="在预览中打开"
              onClick={() => onOpen(selected)}
            >
              <IconExternal size={12} />
            </button>
          </div>
          {diffLines === null ? (
            <div className="dock-empty">加载中…</div>
          ) : diff === "" ? (
            <div className="dock-empty">没有未暂存文本差异</div>
          ) : (
            <pre className="diff-view">
              {diffLines.map((line, index) => (
                <span key={index} className={diffLineClass(line)}>
                  {line || " "}
                  {"\n"}
                </span>
              ))}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

async function revealInExplorer(path: string) {
  try {
    const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
    await revealItemInDir(path);
  } catch {
    // Opener plugin unavailable in test/browser environments.
  }
}

/** File preview pane. */
export function PreviewPane({ request }: { request: PreviewRequest | null }) {
  const [file, setFile] = useState<TextFile | null>(null);
  const [language, setLanguage] = useState<string>("text");
  const [error, setError] = useState<string | null>(null);
  const [wrap, setWrap] = useState(false);
  const [copied, setCopied] = useState(false);
  const path = request?.path ?? null;

  useEffect(() => {
    if (!request) {
      setFile(null);
      setError(null);
      return;
    }
    let alive = true;
    setError(null);
    setFile(null);
    setCopied(false);
    void Promise.all([
      api.readTextFile(request.path),
      api.fileLanguage(request.path),
    ])
      .then(([loaded, lang]) => {
        if (!alive) return;
        setFile(loaded);
        setLanguage(lang);
      })
      .catch((cause) => {
        if (alive) setError(String(cause));
      });
    return () => {
      alive = false;
    };
  }, [request]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1800);
    return () => window.clearTimeout(timer);
  }, [copied]);

  if (!path) {
    return <div className="dock-empty">在文件树或工具卡片里选择文件</div>;
  }
  if (error) return <div className="dock-error">{error}</div>;
  if (!file) return <div className="dock-empty">正在加载…</div>;

  const lines = file.text.replace(/\r\n/g, "\n").split("\n");

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
        <div className="preview-actions">
          <button
            type="button"
            className={`dock-icon-btn ${wrap ? "active" : ""}`}
            aria-pressed={wrap}
            aria-label="自动换行"
            title={wrap ? "关闭自动换行" : "开启自动换行"}
            onClick={() => setWrap((current) => !current)}
          >
            <IconWrap size={13} />
          </button>
          <button
            type="button"
            className="dock-icon-btn"
            aria-label="复制文件内容"
            title={copied ? "已复制" : "复制文件内容"}
            onClick={() => {
              void copyText(file.text)
                .then(() => setCopied(true))
                .catch(() => {});
            }}
          >
            {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
          </button>
          <button
            type="button"
            className="dock-icon-btn"
            aria-label="在资源管理器中显示"
            title="在资源管理器中显示"
            onClick={() => void revealInExplorer(file.path)}
          >
            <IconExternal size={13} />
          </button>
        </div>
      </div>
      <div className={`preview-code ${wrap ? "wrap" : ""}`}>
        <div className="preview-lines" role="region" aria-label="文件内容">
          {lines.map((line, index) => (
            <div key={index} className="preview-line">
              <span className="preview-ln" aria-hidden="true">
                {index + 1}
              </span>
              <span className="preview-text">{line || " "}</span>
            </div>
          ))}
        </div>
      </div>
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
  if (lines.length === 0)
    return <div className="dock-empty">pi 还没有输出日志</div>;

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
