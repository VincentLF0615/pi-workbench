import { memo, useEffect, useRef, useState } from "react";

import {
  Markdown,
  ThinkingBlockView,
  ToolCard,
  revealInPreview,
  summarizeArgs,
} from "./Markdown";
import { copyText } from "../lib/clipboard";
import type { AssistantBlock, TranscriptItem } from "../lib/types";

/** The scrolling conversation view for one session. */
export function Transcript({
  items,
  busy,
  expandTools = false,
}: {
  items: TranscriptItem[];
  busy: boolean;
  expandTools?: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const [pinned, setPinned] = useState(true);
  const empty = items.length === 0;

  // Follow output only while the user remains near the latest message.
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const onScroll = () => {
      const distance =
        element.scrollHeight - element.scrollTop - element.clientHeight;
      const next = distance < 80;
      pinnedRef.current = next;
      setPinned(next);
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => element.removeEventListener("scroll", onScroll);
  }, [empty]);

  useEffect(() => {
    if (!pinnedRef.current) return;
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [items, busy]);

  if (empty) {
    return (
      <div ref={scrollRef} className="transcript empty">
        <div className="empty-card">
          <h2>开始对话</h2>
          <p>选择左侧的项目或会话开始；也可以直接在下方输入。</p>
          <p className="muted">
            运行中：Enter 追加指令，「稍后跟进」等当前任务结束；Esc
            停止并取回排队文字。
          </p>
        </div>
      </div>
    );
  }

  const scrollToLatest = () => {
    const element = scrollRef.current;
    if (!element) return;
    pinnedRef.current = true;
    setPinned(true);
    element.scrollTop = element.scrollHeight;
  };

  return (
    <div className="transcript-shell">
      <div ref={scrollRef} className="transcript">
        {items.map((item) => (
          <Row key={item.id} item={item} expandTools={expandTools} />
        ))}
        {busy && (
          <div className="row assistant">
            <div className="bubble assistant">
              <span className="cursor" />
            </div>
          </div>
        )}
        <div className="transcript-end" />
      </div>
      {!pinned && (
        <button
          type="button"
          className="jump-latest"
          onClick={scrollToLatest}
          aria-label="回到最新消息"
        >
          ↓ 回到最新
        </button>
      )}
    </div>
  );
}

const Row = memo(function Row({
  item,
  expandTools,
}: {
  item: TranscriptItem;
  expandTools: boolean;
}) {
  switch (item.kind) {
    case "user":
      return (
        <div className="row user">
          <div className="bubble user">
            <pre className="user-text">{item.text}</pre>
            {item.images > 0 && (
              <div className="row-meta">图片附件 × {item.images}</div>
            )}
          </div>
        </div>
      );
    case "assistant":
      return (
        <div className="row assistant">
          <div className="bubble assistant">
            {item.blocks.length === 0 && <span className="cursor" />}
            {item.blocks.map((block, index) =>
              block.type === "text" ? (
                <Markdown key={index} text={block.text} />
              ) : block.type === "thinking" ? (
                <ThinkingBlockView
                  key={index}
                  text={block.thinking}
                  streaming={item.streaming}
                />
              ) : (
                <div key={index} className="tool-badge">
                  <span className="tool-badge-name">{block.name}</span>
                  <span className="tool-badge-args">
                    {summarizeArgs(block.arguments)}
                  </span>
                </div>
              ),
            )}
            {item.errorMessage && (
              <div className="row-error">{item.errorMessage}</div>
            )}
            {item.stopReason &&
              item.stopReason !== "stop" &&
              item.stopReason !== "toolUse" && (
                <div className="row-meta">stopReason: {item.stopReason}</div>
              )}
            <CopyAnswerButton blocks={item.blocks} />
          </div>
        </div>
      );
    case "tool":
      return (
        <div className="row tool">
          <ToolCard item={item} defaultOpen={expandTools} />
        </div>
      );
    case "bash":
      return (
        <div className="row tool">
          <BashCard item={item} defaultOpen={expandTools} />
        </div>
      );
    case "compaction":
      return (
        <div className="row info">
          <div className="compaction-card">
            <div className="compaction-title">
              已压缩上下文
              {item.tokensBefore
                ? `（压缩前 ${formatTokens(item.tokensBefore)} tokens）`
                : ""}
            </div>
            {item.summary && (
              <div className="compaction-summary">{item.summary}</div>
            )}
          </div>
        </div>
      );
    case "changedFiles":
      return (
        <div className="row info">
          <div className="changed-files-card">
            <div className="changed-files-title">
              本轮修改了 {item.paths.length} 个文件
            </div>
            <ul className="changed-files-list">
              {item.paths.map((path) => (
                <li key={path}>
                  <button
                    type="button"
                    className="changed-files-path"
                    title={`在预览中打开 ${path}`}
                    onClick={() => revealInPreview(path)}
                  >
                    {path}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      );
    default:
      return (
        <div
          className={`row info ${item.kind === "info" ? `tone-${item.tone}` : ""}`}
        >
          <div className="info-card">{item.text}</div>
        </div>
      );
  }
});

/** Copy an assistant answer without its thinking blocks or tool calls. */
function CopyAnswerButton({ blocks }: { blocks: AssistantBlock[] }) {
  const [state, setState] = useState<"idle" | "done" | "error">("idle");
  const answer = blocks
    .filter(
      (block): block is Extract<AssistantBlock, { type: "text" }> =>
        block.type === "text",
    )
    .map((block) => block.text)
    .join("\n\n")
    .trim();
  if (!answer) return null;
  const onClick = () => {
    void copyText(answer)
      .then(() => {
        setState("done");
        window.setTimeout(() => setState("idle"), 1600);
      })
      .catch(() => setState("error"));
  };
  return (
    <button
      type="button"
      className="copy-answer"
      data-state={state}
      onClick={onClick}
      title={
        state === "error"
          ? "复制失败，请手动选择文本"
          : "复制回答正文（不含思考过程）"
      }
    >
      {state === "error"
        ? "复制失败"
        : state === "done"
          ? "已复制"
          : "复制回答"}
    </button>
  );
}

function BashCard({
  item,
  defaultOpen,
}: {
  item: Extract<TranscriptItem, { kind: "bash" }>;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const failed = item.exitCode != null && item.exitCode !== 0;
  return (
    <div className={`tool-card ${failed ? "tool-error" : "tool-ok"}`}>
      <button
        type="button"
        className="tool-head"
        onClick={() => setOpen(!open)}
        disabled={!item.output}
        aria-expanded={open}
        title={item.output ? "展开或折叠 Bash 输出" : "没有输出"}
      >
        <span className="tool-name">bash</span>
        <span className="tool-summary">{item.command}</span>
        <span className="tool-meta">退出码 {item.exitCode ?? "?"}</span>
        <span className="tool-caret" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open && item.output && <pre className="tool-output">{item.output}</pre>}
    </div>
  );
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}
