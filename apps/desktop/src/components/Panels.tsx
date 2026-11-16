import { useEffect, useMemo, useRef, useState } from "react";
import piMark from "../assets/pi-mark.svg";

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

  useEffect(() => {
    if (!anchor) return;
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [anchor, onClose]);

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
  onRun,
  onClose,
}: {
  open: boolean;
  commands: SlashCommand[] | null;
  busy: boolean;
  onRun: (name: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setIndex(0);
      // Focus after the node exists.
      const timer = window.setTimeout(() => inputRef.current?.focus(), 0);
      return () => window.clearTimeout(timer);
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

  const submit = () => {
    const command = filtered[index];
    if (!command) return;
    onRun(command.name);
    onClose();
  };

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div className="palette" onMouseDown={(event) => event.stopPropagation()}>
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
              submit();
            } else if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            }
          }}
        />
        <div className="palette-list">
          {filtered.length === 0 && (
            <div className="palette-empty">
              {commands === null ? "正在加载命令…" : "没有匹配的命令"}
            </div>
          )}
          {filtered.map((command, at) => (
            <button
              key={`${command.source}:${command.name}`}
              type="button"
              className={`palette-item ${at === index ? "active" : ""}`}
              onMouseEnter={() => setIndex(at)}
              onClick={() => {
                onRun(command.name);
                onClose();
              }}
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
          <span>{busy ? "pi 正在运行" : `${filtered.length} 个命令`}</span>
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
  if (!open) return null;
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-title">从哪条消息分叉？</div>
        <div className="modal-body">
          {messages === null && <div className="muted">正在读取…</div>}
          {messages?.length === 0 && <div className="muted">这个会话还没有可分叉的消息</div>}
          {messages?.map((message) => (
            <button
              key={message.entryId}
              type="button"
              className="fork-item"
              onClick={() => {
                onPick(message.entryId);
                onClose();
              }}
            >
              {message.text.length > 120 ? `${message.text.slice(0, 120)}…` : message.text}
            </button>
          ))}
        </div>
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            取消
          </button>
        </div>
      </div>
    </div>
  );
}

/** Settings modal. */
export function SettingsDialog({
  open,
  settings,
  settingsPath,
  onChange,
  onClose,
}: {
  open: boolean;
  settings: {
    theme: string;
    fontSize: number;
    fontFamily: string;
    sidebarWidth: number;
    expandTools: boolean;
    logLevel: string;
    minimizeToTray: boolean;
  };
  settingsPath: string | null;
  onChange: (patch: Record<string, unknown>) => void;
  onClose: () => void;
}) {
  if (!open) return null;
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal wide" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-title">设置</div>
        <div className="modal-body settings-body">
          <label className="setting-row">
            <span className="setting-label">主题</span>
            <div className="setting-control">
              {["system", "light", "dark"].map((theme) => (
                <button
                  key={theme}
                  type="button"
                  className={`level-chip ${settings.theme === theme ? "active" : ""}`}
                  onClick={() => onChange({ theme })}
                >
                  {theme === "system" ? "跟随系统" : theme === "light" ? "亮色" : "暗色"}
                </button>
              ))}
            </div>
          </label>

          <label className="setting-row">
            <span className="setting-label">字号</span>
            <div className="setting-control">
              <input
                type="range"
                min={11}
                max={20}
                step={1}
                value={settings.fontSize}
                onChange={(event) => onChange({ fontSize: Number(event.target.value) })}
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
                onChange={(event) => onChange({ fontFamily: event.target.value })}
              />
            </div>
          </label>

          <label className="setting-row">
            <span className="setting-label">侧栏宽度</span>
            <div className="setting-control">
              <input
                type="range"
                min={220}
                max={480}
                step={10}
                value={settings.sidebarWidth}
                onChange={(event) => onChange({ sidebarWidth: Number(event.target.value) })}
              />
              <span className="setting-value">{settings.sidebarWidth}px</span>
            </div>
          </label>

          <label className="setting-row">
            <span className="setting-label">默认展开工具详情</span>
            <div className="setting-control">
              <input
                type="checkbox"
                checked={settings.expandTools}
                onChange={(event) => onChange({ expandTools: event.target.checked })}
              />
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
              <input type="checkbox" checked={settings.minimizeToTray}
                onChange={(event) => onChange({ minimizeToTray: event.target.checked })} />
            </div>
          </label>
          <p className="setting-note">收起后任务继续运行。点击托盘图标恢复，右键菜单可退出；关闭窗口仍会退出应用。</p>

          <section className="about-brand" aria-label="关于 Pi Workbench">
            <img src={piMark} alt="Pi 官方彩色标志" />
            <div><h3>关于 Pi Workbench</h3>
              <p>个人使用的非官方 Pi 桌面客户端，未获 Pi / Earendil 官方背书。</p>
              <p>图标采用 Pi 官方彩色标志，保留原图形和配色。</p>
              <button type="button" className="link-button" onClick={() => {
                void import("@tauri-apps/plugin-opener")
                  .then(({ openUrl }) => openUrl("https://pi.dev/press-kit"))
                  .catch((cause) => console.error("Unable to open Pi Press Kit", cause));
              }}>图标来源：Pi Press Kit ↗</button>
            </div>
          </section>

          {settingsPath && (
            <div className="setting-note">
              设置文件：<code>{settingsPath}</code>
            </div>
          )}
        </div>
        <div className="modal-actions">
          <button type="button" className="btn primary" onClick={onClose}>
            完成
          </button>
        </div>
      </div>
    </div>
  );
}

/** Read-only session tree for branch navigation. */
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
  return nodes.reduce((total, node) => total + 1 + countNodes(node.children ?? []), 0);
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
          <button type="button" className="tree-caret" onClick={() => setOpen(!open)}>
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
            <TreeNode key={child.entry.id || index} node={child} onFork={onFork} />
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
    const message = entry.message as { role?: string; content?: unknown } | undefined;
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
  return Number.isFinite(time.getTime()) ? time.toLocaleTimeString() : entry.type;
}
