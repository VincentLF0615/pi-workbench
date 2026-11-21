import { useEffect, useMemo, useState } from "react";
import { copyText } from "../lib/clipboard";
import { openExternal, safeExternalUrl } from "../lib/external";

import type {
  AssistantBlock,
  messageText,
  textOfContent,
  toolResultText,
  TranscriptItem,
} from "../lib/types";

/** Minimal, dependency-free markdown renderer for assistant answers. */
export function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => splitBlocks(text), [text]);
  return (
    <div className="md">
      {blocks.map((block, index) => (
        <Block key={index} block={block} />
      ))}
    </div>
  );
}

type Block =
  | { kind: "para"; lines: string[] }
  | { kind: "code"; lang: string; code: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "quote"; lines: string[] }
  | { kind: "heading"; level: number; text: string }
  | { kind: "rule" };

function splitBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let listItems: string[] = [];
  let listOrdered = false;
  let quote: string[] = [];
  let index = 0;

  const flushParagraph = () => {
    if (paragraph.length) blocks.push({ kind: "para", lines: paragraph });
    paragraph = [];
  };
  const flushList = () => {
    if (listItems.length)
      blocks.push({ kind: "list", ordered: listOrdered, items: listItems });
    listItems = [];
  };
  const flushQuote = () => {
    if (quote.length) blocks.push({ kind: "quote", lines: quote });
    quote = [];
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
    flushQuote();
  };

  while (index < lines.length) {
    const line = lines[index];
    index += 1;

    if (line.trim().startsWith("```")) {
      flushAll();
      const lang = line.trim().slice(3).trim();
      const code: string[] = [];
      while (index < lines.length && !lines[index].trim().startsWith("```")) {
        code.push(lines[index]);
        index += 1;
      }
      index += 1; // closing fence
      blocks.push({ kind: "code", lang, code: code.join("\n") });
      continue;
    }

    if (!line.trim()) {
      flushAll();
      continue;
    }

    if (/^#{1,6}\s/.test(line.trim())) {
      flushAll();
      const level = line.trim().match(/^#+/)![0].length;
      blocks.push({
        kind: "heading",
        level,
        text: line.trim().slice(level).trim(),
      });
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      flushAll();
      blocks.push({ kind: "rule" });
      continue;
    }

    if (line.trim().startsWith(">")) {
      flushParagraph();
      flushList();
      quote.push(line.trim().slice(1).trim());
      continue;
    }

    const bullet = line.match(/^\s*([-*+]|\d+[.)])\s+(.*)$/);
    if (bullet) {
      flushParagraph();
      flushQuote();
      const ordered = /\d/.test(bullet[1]);
      if (listItems.length && ordered !== listOrdered) flushList();
      listOrdered = ordered;
      listItems.push(bullet[2]);
      continue;
    }

    flushList();
    flushQuote();
    paragraph.push(line.trim());
  }

  flushAll();
  return blocks;
}

function Block({ block }: { block: Block }) {
  switch (block.kind) {
    case "code":
      return <CodeBlock block={block} />;
    case "heading": {
      const Tag = `h${Math.min(block.level, 6)}` as "h1";
      return <Tag className="md-heading">{inline(block.text)}</Tag>;
    }
    case "list":
      return block.ordered ? (
        <ol className="md-list">
          {block.items.map((item, index) => (
            <li key={index}>{inline(item)}</li>
          ))}
        </ol>
      ) : (
        <ul className="md-list">
          {block.items.map((item, index) => (
            <li key={index}>{inline(item)}</li>
          ))}
        </ul>
      );
    case "quote":
      return (
        <blockquote className="md-quote">{block.lines.map(inline)}</blockquote>
      );
    case "rule":
      return <hr className="md-rule" />;
    default:
      return <p className="md-para">{block.lines.map(inline)}</p>;
  }
}

/** Render inline code, bold and italic spans. */
function inline(text: string) {
  const parts = text.split(/(`[^`]+`)/g);
  return parts.map((part, index) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 1) {
      return (
        <code key={index} className="md-inline-code">
          {part.slice(1, -1)}
        </code>
      );
    }
    const bold = part.split(/(\*\*[^*]+\*\*)/g);
    return bold.map((chunk, chunkIndex) => {
      if (chunk.startsWith("**") && chunk.endsWith("**") && chunk.length > 4) {
        return (
          <strong key={`${index}-${chunkIndex}`}>
            {renderLinks(chunk.slice(2, -2))}
          </strong>
        );
      }
      return <span key={`${index}-${chunkIndex}`}>{renderLinks(chunk)}</span>;
    });
  });
}

function renderLinks(text: string) {
  const parts = text.split(/(\[[^\]]+\]\([^)]+\))/g);
  return parts.map((part, index) => {
    const match = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (!match) return part;
    const url = safeExternalUrl(match[2]);
    return url ? (
      <ExternalLink key={`${index}:${url}`} url={url}>
        {match[1]}
      </ExternalLink>
    ) : (
      part
    );
  });
}

function ExternalLink({
  url,
  children,
}: {
  url: string;
  children: React.ReactNode;
}) {
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="md-link">
      <a
        href={url}
        rel="noreferrer noopener"
        title={error ?? `打开链接：${url}`}
        onClick={(event) => {
          event.preventDefault();
          setError(null);
          void openExternal(url).catch((cause) => setError(String(cause)));
        }}
      >
        {children}
      </a>
      {error && (
        <span className="md-link-error" role="alert">
          打开失败
        </span>
      )}
    </span>
  );
}

function CodeBlock({ block }: { block: Extract<Block, { kind: "code" }> }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <div className="md-code">
      <div className="md-codebar">
        <span className="md-code-lang">{block.lang || "代码"}</span>
        <button
          type="button"
          className="code-copy"
          aria-label="复制代码"
          title={error ?? "复制代码"}
          onClick={() => {
            setError(null);
            void copyText(block.code)
              .then(() => setCopied(true))
              .catch((cause) => setError(String(cause)));
          }}
        >
          {error ? "复制失败" : copied ? "已复制" : "复制"}
        </button>
      </div>
      <pre>
        <code>{block.code}</code>
      </pre>
    </div>
  );
}

/** Render one assistant message block. */
export function AssistantBlockView({ block }: { block: AssistantBlock }) {
  if (block.type === "text") return <Markdown text={block.text} />;
  if (block.type === "thinking")
    return <ThinkingBlockView text={block.thinking} />;
  return <ToolCallBadge name={block.name} arguments={block.arguments} />;
}

export function ThinkingBlockView({
  text,
  streaming = false,
}: {
  text: string;
  streaming?: boolean;
}) {
  // Auto-expand while streaming, auto-collapse when the turn ends —
  // unless the user toggled this block manually (PI-Desktop #1857/#2174).
  const [userToggled, setUserToggled] = useState(false);
  const [userOpen, setUserOpen] = useState(false);
  const open = userToggled ? userOpen : streaming;
  return (
    <div className="thinking">
      <button
        type="button"
        className="thinking-toggle"
        onClick={() => {
          setUserToggled(true);
          setUserOpen(!open);
        }}
        aria-expanded={open}
      >
        {open ? "▾" : "▸"} 思考过程（{text.length} 字）
        {streaming && <span className="thinking-live">· 生成中</span>}
      </button>
      {open && <pre className="thinking-body">{text}</pre>}
    </div>
  );
}

function ToolCallBadge({
  name,
  arguments: args,
}: {
  name: string;
  arguments: Record<string, unknown>;
}) {
  const summary = summarizeArgs(args);
  return (
    <div className="tool-badge">
      <span className="tool-badge-name">{name}</span>
      {summary && <span className="tool-badge-args">{summary}</span>}
    </div>
  );
}

/** One tool call card, with a per-tool compact view. */
export function ToolCard({
  item,
  defaultOpen = false,
}: {
  item: Extract<TranscriptItem, { kind: "tool" }>;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const duration = item.durationMs != null ? `${item.durationMs}ms` : "";
  const filePath = filePathOf(item.args);

  return (
    <div className={`tool-card tool-${item.state}`}>
      <button
        type="button"
        className="tool-head"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <span className={`tool-dot tool-dot-${item.state}`} />
        <span className="tool-name">{item.name}</span>
        {filePath ? (
          <span
            className="tool-summary tool-path"
            role="link"
            tabIndex={-1}
            title={`在预览中打开 ${filePath}`}
            onClick={(event) => {
              event.stopPropagation();
              revealInPreview(filePath);
            }}
          >
            {filePath}
          </span>
        ) : (
          <span className="tool-summary">{summarizeArgs(item.args)}</span>
        )}
        <span className="tool-meta">
          {item.state === "running"
            ? "运行中…"
            : item.state === "error"
              ? "失败"
              : "完成"}
          {duration ? ` · ${duration}` : ""}
        </span>
        <span className="tool-caret">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="tool-body">
          <div className="tool-section">
            <div className="tool-label">参数</div>
            <pre>{JSON.stringify(item.args, null, 2)}</pre>
          </div>
          {(item.resultText || item.partial) && (
            <div className="tool-section">
              <div className="tool-label">输出</div>
              <pre
                className={item.isError ? "tool-output error" : "tool-output"}
              >
                {item.resultText || item.partial}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** One-line description of a tool call's arguments. */
export function summarizeArgs(args: Record<string, unknown>): string {
  if (!args || typeof args !== "object") return "";
  const path = args.path;
  if (typeof path === "string") return path;
  const command = args.command;
  if (typeof command === "string") return truncate(command, 80);
  const pattern = args.pattern;
  if (typeof pattern === "string") return truncate(pattern, 60);
  const url = args.url;
  if (typeof url === "string") return url;
  const keys = Object.keys(args);
  if (keys.length === 0) return "";
  return truncate(
    keys.map((key) => `${key}=${JSON.stringify(args[key])}`).join(" "),
    80,
  );
}

/** A file path from a tool call's arguments, if it names one. */
export function filePathOf(args: Record<string, unknown>): string | null {
  const path = args.path;
  return typeof path === "string" && path.length > 0 ? path : null;
}

/** Ask the preview pane to open a file. */
export function revealInPreview(path: string) {
  window.dispatchEvent(
    new CustomEvent("pi-workbench:reveal", { detail: { path } }),
  );
}

function truncate(text: string, max: number) {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** Text content of a message, for history rendering. */
export { messageText, textOfContent, toolResultText };

/** Ask the OS to open a path outside the app. */
export function useOpenExternal() {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!error) return;
    const timer = window.setTimeout(() => setError(null), 4000);
    return () => window.clearTimeout(timer);
  }, [error]);
  return { error };
}
