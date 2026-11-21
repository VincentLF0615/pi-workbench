import { useEffect, useId, useMemo, useRef, useState } from "react";
import piMark from "../assets/pi-mark.png";
import { useDialogFocus } from "../lib/useDialogFocus";

import type { SessionEntry, SlashCommand } from "../lib/types";

/** A node of the session tree, with a tolerant shape for pi's optional fields. */
type TreeChild = {
  entry: SessionEntry;
  children?: TreeChild[];
  label?: string;
  labelTimestamp?: string;
};

/** A context menu anchored to an element. */
export function Menu({
  anchor,
  items,
  onClose,
}: {
  anchor: { x: number; y: number } | null;
  items: MenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!anchor) return;
    const previous = document.activeElement as HTMLElement | null;
    const timer = window.setTimeout(() => {
      ref.current
        ?.querySelector<HTMLButtonElement>(".menu-item:not(:disabled)")
        ?.focus();
    }, 0);
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        closeRef.current();
      }
    };
    const moveFocus = (key: string) => {
      const buttons = Array.from(
        ref.current?.querySelectorAll<HTMLButtonElement>(
          ".menu-item:not(:disabled)",
        ) ?? [],
      );
      if (buttons.length === 0) return;
      const current = buttons.indexOf(
        document.activeElement as HTMLButtonElement,
      );
      const next =
        key === "Home"
          ? 0
          : key === "End"
            ? buttons.length - 1
            : key === "ArrowUp"
              ? (current <= 0 ? buttons.length : current) - 1
              : (current + 1) % buttons.length;
      buttons[next].focus();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
      } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        event.stopPropagation();
        moveFocus(event.key);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      if (previous?.isConnected) previous.focus();
    };
  }, [anchor]);

  if (!anchor) return null;

  // Keep the menu inside the viewport.
  const width = 200;
  const height = items.length * 30 + 8;
  const left = Math.min(anchor.x, window.innerWidth - width - 8);
  const top = Math.min(anchor.y, window.innerHeight - height - 8);

  return (
    <div
      ref={ref}
      className="menu"
      style={{ left, top, width }}
      role="menu"
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item, index) =>
        item.kind === "separator" ? (
          <div key={index} className="menu-separator" />
        ) : (
          <button
            key={index}
            type="button"
            className={`menu-item ${item.tone ?? ""}`}
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              item.onSelect?.();
              onClose();
            }}
          >
            <span>{item.label}</span>
            {item.hint && <span className="menu-hint">{item.hint}</span>}
          </button>
        ),
      )}
    </div>
  );
}

export type MenuItem =
  | { kind: "separator" }
  | {
      kind?: "item";
      label: string;
      hint?: string;
      tone?: "danger";
      disabled?: boolean;
      onSelect?: () => void;
    };

/** Ctrl/Cmd+K command palette over pi's slash commands. */
export function CommandPalette({
  open,
  commands,
  busy,
  error = null,
  onRun,
  onClose,
}: {
  open: boolean;
  commands: SlashCommand[] | null;
  busy: boolean;
  error?: string | null;
  onRun: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [runError, setRunError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const { requestClose, onKeyDown } = useDialogFocus({
    open,
    onClose,
    dialogRef,
    initialFocusRef: inputRef,
    pending,
  });

  useEffect(() => {
    if (open) {
      setQuery("");
      setIndex(0);
      setRunError(null);
    }
  }, [open]);

  const filtered = useMemo(() => {
    const list = commands ?? [];
    const needle = query.trim().toLowerCase();
    if (!needle) return list;
    return list.filter(
      (command) =>
        command.name.toLowerCase().includes(needle) ||
        (command.description ?? "").toLowerCase().includes(needle),
    );
  }, [commands, query]);

  useEffect(() => {
    setIndex(0);
  }, [query]);

  if (!open) return null;

  const submit = async (name?: string) => {
    const commandName = name ?? filtered[index]?.name;
    if (!commandName || pending) return;
    setPending(true);
    setRunError(null);
    try {
      await onRun(commandName);
      onClose();
    } catch (cause) {
      setRunError(`命令运行失败：${String(cause)}`);
    } finally {
      setPending(false);
    }
  };

  return (
    <div
      className="palette-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <div
        ref={dialogRef}
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Pi 命令面板"
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <input
          ref={inputRef}
          className="palette-input"
          placeholder="搜索命令…（Enter 运行）"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setIndex((current) => Math.min(current + 1, filtered.length - 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setIndex((current) => Math.max(current - 1, 0));
            } else if (event.key === "Enter") {
              event.preventDefault();
              void submit();
            }
          }}
        />
        {(runError || error) && (
          <div className="palette-error" role="alert">
            {runError ?? error}
          </div>
        )}
        <div className="palette-list">
          {filtered.length === 0 && !error && !runError && (
            <div className="palette-empty">
              {commands === null ? "正在加载命令…" : "没有匹配的命令"}
            </div>
          )}
          {filtered.map((command, at) => (
            <button
              key={`${command.source}:${command.name}`}
              type="button"
              className={`palette-item ${at === index ? "active" : ""}`}
              disabled={pending}
              onMouseEnter={() => setIndex(at)}
              onClick={() => void submit(command.name)}
            >
              <span className="palette-name">/{command.name}</span>
              {command.description && (
                <span className="palette-desc">{command.description}</span>
              )}
              <span className={`palette-source source-${command.source}`}>
                {sourceLabel(command.source)}
              </span>
            </button>
          ))}
        </div>
        <div className="palette-footer">
          <span>↑↓ 选择 · Enter 运行 · Esc 关闭</span>
          <span>
            {pending
              ? "正在运行命令…"
              : busy
                ? "pi 正在运行"
                : `${filtered.length} 个命令`}
          </span>
        </div>
      </div>
    </div>
  );
}

function sourceLabel(source: string): string {
  switch (source) {
    case "extension":
      return "扩展";
    case "prompt":
      return "模板";
    case "skill":
      return "技能";
    default:
      return source;
  }
}

/** Fork dialog: pick which user message to branch from. */
export function ForkDialog({
  open,
  messages,
  onPick,
  onClose,
}: {
  open: boolean;
  messages: { entryId: string; text: string }[] | null;
  onPick: (entryId: string) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const { requestClose, onKeyDown } = useDialogFocus({
    open,
    onClose,
    dialogRef,
  });
  if (!open) return null;
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <div
        ref={dialogRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <div className="modal-title" id={titleId}>
          从哪条消息分叉？
        </div>
        <div className="modal-body">
          {messages === null && <div className="muted">正在读取…</div>}
          {messages?.length === 0 && (
            <div className="muted">这个会话还没有可分叉的消息</div>
          )}
          {messages?.map((message) => (
            <button
              key={message.entryId}
              type="button"
              className="fork-item"
              onClick={() => {
                onPick(message.entryId);
                requestClose();
              }}
            >
              {message.text.length > 120
                ? `${message.text.slice(0, 120)}…`
                : message.text}
            </button>
          ))}
        </div>
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={requestClose}>
            取消
          </button>
        </div>
      </div>
    </div>
  );
}

function themeLabel(theme: string) {
  switch (theme) {
    case "system":
      return "跟随系统";
    case "light":
      return "亮色";
    case "parchment":
      return "羊皮纸";
    default:
      return "暗色";
  }
}

/** Settings modal. */
export function SettingsDialog({
  open,
  settings,
  settingsPath,
  piVersion,
  onChange,
  onClose,
}: {
  open: boolean;
  settings: {
    theme: string;
    fontSize: number;
    fontFamily: string;
    sidebarWidth: number;
    dockWidth?: number;
    expandTools: boolean;
    logLevel: string;
    minimizeToTray: boolean;
  };
  settingsPath: string | null;
  piVersion?: string | null;
  onChange: (patch: Record<string, unknown>) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const { requestClose, onKeyDown } = useDialogFocus({
    open,
    onClose,
    dialogRef,
  });
  if (!open) return null;
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <div
        ref={dialogRef}
        className="modal wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <div className="modal-title" id={titleId}>
          设置
        </div>
        <div className="modal-body settings-body">
          <div className="setting-row">
            <span className="setting-label">主题</span>
            <div className="setting-control theme-chips">
              {["system", "light", "parchment", "dark"].map((theme) => (
                <button
                  key={theme}
                  type="button"
                  className={`level-chip theme-chip ${settings.theme === theme ? "active" : ""}`}
                  aria-label={themeLabel(theme)}
                  aria-pressed={settings.theme === theme}
                  onClick={() => onChange({ theme })}
                >
                  <span
                    className={`theme-swatch swatch-${theme}`}
                    aria-hidden="true"
                  />
                  {themeLabel(theme)}
                </button>
              ))}
            </div>
          </div>

          <label className="setting-row">
            <span className="setting-label">字号</span>
            <div className="setting-control">
              <input
                type="range"
                className="range-input"
                min={11}
                max={20}
                step={1}
                value={settings.fontSize}
                onChange={(event) =>
                  onChange({ fontSize: Number(event.target.value) })
                }
              />
              <span className="setting-value">{settings.fontSize}px</span>
            </div>
          </label>

          <label className="setting-row">
            <span className="setting-label">字体</span>
            <div className="setting-control">
              <input
                className="input"
                placeholder="留空使用内置字体栈"
                value={settings.fontFamily}
                onChange={(event) =>
                  onChange({ fontFamily: event.target.value })
                }
              />
            </div>
          </label>

          <label className="setting-row">
            <span className="setting-label">侧栏宽度</span>
            <div className="setting-control">
              <input
                type="range"
                className="range-input"
                min={220}
                max={480}
                step={10}
                value={settings.sidebarWidth}
                onChange={(event) =>
                  onChange({ sidebarWidth: Number(event.target.value) })
                }
              />
              <span className="setting-value">{settings.sidebarWidth}px</span>
            </div>
          </label>

          <label className="setting-row">
            <span className="setting-label">右侧面板宽度</span>
            <div className="setting-control">
              <input
                type="range"
                className="range-input"
                min={240}
                max={620}
                step={10}
                value={settings.dockWidth ?? 320}
                onChange={(event) =>
                  onChange({ dockWidth: Number(event.target.value) })
                }
              />
              <span className="setting-value">
                {settings.dockWidth ?? 320}px
              </span>
            </div>
          </label>

          <label className="setting-row">
            <span className="setting-label">默认展开工具详情</span>
            <div className="setting-control">
              <span className="toggle-switch">
                <input
                  type="checkbox"
                  checked={settings.expandTools}
                  onChange={(event) =>
                    onChange({ expandTools: event.target.checked })
                  }
                />
                <span className="toggle-track" aria-hidden="true" />
              </span>
            </div>
          </label>

          <label className="setting-row">
            <span className="setting-label">日志级别</span>
            <div className="setting-control">
              <select
                className="input"
                value={settings.logLevel}
                onChange={(event) => onChange({ logLevel: event.target.value })}
              >
                {["error", "warn", "info", "debug", "trace"].map((level) => (
                  <option key={level} value={level}>
                    {level}
                  </option>
                ))}
              </select>
            </div>
          </label>

          <label className="setting-row">
            <span className="setting-label">最小化到托盘</span>
            <div className="setting-control">
              <span className="toggle-switch">
                <input
                  type="checkbox"
                  checked={settings.minimizeToTray}
                  onChange={(event) =>
                    onChange({ minimizeToTray: event.target.checked })
                  }
                />
                <span className="toggle-track" aria-hidden="true" />
              </span>
            </div>
          </label>
          <p className="setting-note">
            收起后任务继续运行。点击托盘图标恢复，右键菜单可退出；关闭窗口仍会退出应用。
          </p>

          <section className="about-brand" aria-label="关于 Pi Workbench">
            <img src={piMark} alt="Pi Workbench 图标" />
            <div>
              <h3>
                Pi Workbench <span className="about-version">v0.1.3</span>
              </h3>
              <p>
                纯原生 Pi RPC 桌面工作台，零额外提示词注入，复用本机 Pi
                配置、模型与扩展。
                {piVersion ? `当前已连接 Pi ${piVersion}。` : ""}
              </p>
              <p>
                个人使用的非官方桌面客户端，未获 Pi / Earendil
                官方背书；图标为本项目原创设计。
              </p>
            </div>
          </section>

          {settingsPath && (
            <div className="setting-note">
              设置文件：<code>{settingsPath}</code>
            </div>
          )}
        </div>
        <div className="modal-actions">
          <button type="button" className="btn primary" onClick={requestClose}>
            完成
          </button>
        </div>
      </div>
    </div>
  );
}

/** Rename a session without falling back to a native prompt. */
export function RenameDialog({
  open,
  current,
  onSubmit,
  onClose,
}: {
  open: boolean;
  current: string;
  onSubmit: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const [value, setValue] = useState(current);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const { requestClose, onKeyDown } = useDialogFocus({
    open,
    onClose,
    dialogRef,
    initialFocusRef: inputRef,
    pending,
  });

  useEffect(() => {
    if (open) {
      setValue(current);
      setError(null);
    }
  }, [open, current]);

  if (!open) return null;
  const submit = async () => {
    if (pending || !value.trim()) return;
    setPending(true);
    setError(null);
    try {
      await onSubmit(value.trim());
      onClose();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <div
        ref={dialogRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <div className="modal-title" id={titleId}>
          重命名会话
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="modal-body">
            <input
              ref={inputRef}
              className="input"
              aria-label="会话名称"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              disabled={pending}
              autoFocus
            />
            {error && (
              <div className="row-error" role="alert">
                {error}
              </div>
            )}
          </div>
          <div className="modal-actions">
            <button
              type="button"
              className="btn ghost"
              onClick={requestClose}
              disabled={pending}
            >
              取消
            </button>
            <button
              type="submit"
              className="btn primary"
              disabled={pending || !value.trim()}
            >
              {pending ? "保存中…" : "保存名称"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** Confirmation dialog for destructive session operations. */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  pendingLabel = "处理中…",
  danger = false,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  pendingLabel?: string;
  danger?: boolean;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const messageId = useId();
  const { requestClose, onKeyDown } = useDialogFocus({
    open,
    onClose,
    dialogRef,
    initialFocusRef: danger ? cancelRef : confirmRef,
    pending,
  });

  useEffect(() => {
    if (open) setError(null);
  }, [open]);

  if (!open) return null;
  const confirm = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <div
        ref={dialogRef}
        className="modal"
        role={danger ? "alertdialog" : "dialog"}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <div className="modal-title" id={titleId}>
          {title}
        </div>
        <div className="modal-body">
          <p className="confirm-message" id={messageId}>
            {message}
          </p>
          {error && (
            <div className="row-error" role="alert">
              {error}
            </div>
          )}
        </div>
        <div className="modal-actions">
          <button
            ref={cancelRef}
            type="button"
            className="btn ghost"
            onClick={requestClose}
            disabled={pending}
          >
            取消
          </button>
          <button
            ref={confirmRef}
            type="button"
            className={`btn ${danger ? "danger" : "primary"}`}
            onClick={() => void confirm()}
            disabled={pending}
          >
            {pending ? pendingLabel : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Read-only session tree for branch navigation. */
export function SessionTreePanel({
  tree,
  onFork,
  onClose,
}: {
  tree: TreeChild[] | null;
  onFork: (entryId: string) => void;
  onClose: () => void;
}) {
  if (!tree) return null;

  const total = countNodes(tree);
  return (
    <div className="tree-panel">
      <div className="tree-head">
        <span>会话树 · {total} 个节点</span>
        <button type="button" className="btn ghost" onClick={onClose}>
          关闭
        </button>
      </div>
      <div className="tree-body">
        {tree.map((node, index) => (
          <TreeNode key={node.entry.id || index} node={node} onFork={onFork} />
        ))}
      </div>
    </div>
  );
}

function countNodes(nodes: TreeChild[]): number {
  return nodes.reduce(
    (total, node) => total + 1 + countNodes(node.children ?? []),
    0,
  );
}

function TreeNode({
  node,
  onFork,
}: {
  node: TreeChild;
  onFork: (entryId: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const entry = node.entry;
  const label = node.label ?? entryLabel(entry);
  const children = node.children ?? [];

  return (
    <div className="tree-node">
      <div className="tree-row">
        {children.length > 0 ? (
          <button
            type="button"
            className="tree-caret"
            onClick={() => setOpen(!open)}
          >
            {open ? "▾" : "▸"}
          </button>
        ) : (
          <span className="tree-caret empty" />
        )}
        <span className={`tree-type type-${entry.type}`}>{entry.type}</span>
        <span className="tree-label" title={label}>
          {label}
        </span>
        {entry.type === "message" && (
          <button
            type="button"
            className="tree-fork"
            onClick={() => onFork(entry.id)}
            title="从这里分叉"
          >
            分叉
          </button>
        )}
      </div>
      {open && children.length > 0 && (
        <div className="tree-children">
          {children.map((child, index) => (
            <TreeNode
              key={child.entry.id || index}
              node={child}
              onFork={onFork}
            />
          ))}
        </div>
      )}
    </div>
  );
}
function entryLabel(entry: {
  type: string;
  timestamp: string;
  [key: string]: unknown;
}): string {
  if (entry.type === "message") {
    const message = entry.message as
      { role?: string; content?: unknown } | undefined;
    const role = message?.role ?? "?";
    const text =
      typeof message?.content === "string"
        ? message.content
        : Array.isArray(message?.content)
          ? (message.content as { text?: string }[])
              .map((block) => block.text ?? "")
              .filter(Boolean)
              .join(" ")
          : "";
    const preview = text.trim().slice(0, 60);
    return preview ? `${role}: ${preview}` : role;
  }
  if (entry.type === "compaction") return "压缩";
  if (entry.type === "model_change") {
    return `模型 → ${String(entry.modelId ?? "?")}`;
  }
  if (entry.type === "thinking_level_change") {
    return `思考 → ${String(entry.thinkingLevel ?? "?")}`;
  }
  const time = new Date(entry.timestamp);
  return Number.isFinite(time.getTime())
    ? time.toLocaleTimeString()
    : entry.type;
}
