import { useEffect, useRef } from "react";

import {
  Markdown,
  ThinkingBlockView,
  ToolCard,
  summarizeArgs,
} from "./Markdown";
import type { TranscriptItem } from "../lib/types";

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

  // Keep the view pinned to the bottom while new content streams in.
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const onScroll = () => {
      const distance =
        element.scrollHeight - element.scrollTop - element.clientHeight;
      pinnedRef.current = distance < 80;
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => element.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (!pinnedRef.current) return;
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [items, busy]);

  if (items.length === 0) {
    return (
      <div ref={scrollRef} className="transcript empty">
        <div className="empty-card">
          <h2>开始对话</h2>
          <p>选择左侧的项目或会话开始；也可以直接在下方输入。</p>
          <p className="muted">
            提示：运行中按 Esc 或点「停止」中断；输入新消息会作为 steer 追加。
          </p>
        </div>
      </div>
    );
  }

  return (
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
  );
}

function Row({
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
                <ThinkingBlockView key={index} text={block.thinking} />
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
          <div className="tool-card tool-ok">
            <div className="tool-head static">
              <span className="tool-name">bash</span>
              <span className="tool-summary">{item.command}</span>
              <span className="tool-meta">{item.exitCode ?? "?"}</span>
            </div>
            {item.output && <pre className="tool-output">{item.output}</pre>}
          </div>
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
    default:
      return (
        <div
          className={`row info ${item.kind === "info" ? `tone-${item.tone}` : ""}`}
        >
          <div className="info-card">{item.text}</div>
        </div>
      );
  }
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}
