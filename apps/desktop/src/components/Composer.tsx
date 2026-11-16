import { useEffect, useRef, useState } from "react";

import { api } from "../lib/api";
import type { UiRequest } from "../lib/types";

/** The composer: text entry, image paste, send/stop and steer. */
export function Composer({
  sessionId,
  busy,
  onSend,
  onSteer,
  onAbort,
}: {
  sessionId: string | null;
  busy: boolean;
  onSend: (text: string) => void;
  onSteer: (text: string) => void;
  onAbort: () => void;
}) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [mode, setMode] = useState<"send" | "steer">("send");
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setMode(busy ? "steer" : "send");
  }, [busy]);

  // Esc aborts the run, matching the terminal client.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && busy) {
        event.preventDefault();
        onAbort();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onAbort]);

  const submit = () => {
    const value = text.trim();
    if (!value || !sessionId) return;
    if (mode === "steer") onSteer(value);
    else onSend(value);
    setText("");
    setImages([]);
  };

  const onPaste = (event: React.ClipboardEvent) => {
    const files = Array.from(event.clipboardData.files ?? []);
    const image = files.find((file) => file.type.startsWith("image/"));
    if (!image) return;
    event.preventDefault();
    // Images are sent as base64 data URLs; the backend forwards them to pi.
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        setImages((current) => [...current, reader.result as string]);
      }
    };
    reader.readAsDataURL(image);
  };

  const onDrop = (event: React.DragEvent) => {
    const files = Array.from(event.dataTransfer.files ?? []);
    const image = files.find((file) => file.type.startsWith("image/"));
    if (!image) return;
    event.preventDefault();
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        setImages((current) => [...current, reader.result as string]);
      }
    };
    reader.readAsDataURL(image);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends, Shift+Enter inserts a newline. This works with CJK IMEs
    // because we check the composition state.
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div className="composer" onDrop={onDrop}>
      {images.length > 0 && (
        <div className="composer-images">
          {images.map((image, index) => (
            <div key={index} className="composer-image">
              <img src={image} alt={`attachment ${index + 1}`} />
              <button
                type="button"
                className="composer-image-remove"
                onClick={() => setImages((current) => current.filter((_, i) => i !== index))}
                aria-label="remove image"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="composer-main">
        <textarea
          ref={ref}
          className="composer-input"
          placeholder={sessionId ? "输入消息，Enter 发送，Shift+Enter 换行" : "先打开一个会话"}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          disabled={!sessionId}
          rows={3}
        />
        <div className="composer-actions">
          <span className="composer-hint">
            {busy ? "pi 正在运行 · Esc 停止" : "Enter 发送"}
          </span>
          {busy && (
            <button type="button" className="btn ghost" onClick={onAbort}>
              停止
            </button>
          )}
          <button
            type="button"
            className={`btn ${mode === "steer" ? "secondary" : "primary"}`}
            onClick={submit}
            disabled={!sessionId || !text.trim()}
          >
            {mode === "steer" ? "追加指令" : "发送"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Context usage ring next to the model name. */
export function ContextRing({
  percent,
  tokens,
  contextWindow,
}: {
  percent?: number | null;
  tokens?: number;
  contextWindow?: number;
}) {
  const value = percent ?? 0;
  const radius = 9;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - Math.min(value, 100) / 100);
  const title =
    contextWindow && tokens != null
      ? `上下文 ${tokens} / ${contextWindow}（${value}%）`
      : "上下文用量";

  return (
    <div className="context-ring" title={title}>
      <svg width="24" height="24" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r={radius} className="ring-bg" />
        <circle
          cx="12"
          cy="12"
          r={radius}
          className="ring-fg"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
        />
      </svg>
      <span className="ring-label">{Math.round(value)}%</span>
    </div>
  );
}

/** Answer to an extension dialog. */
export type UiAnswer =
  | { kind: "value"; requestId: string; value: string }
  | { kind: "confirmed"; requestId: string; value: boolean }
  | { kind: "cancelled"; requestId: string };

/** Extension dialogs, rendered inline in the transcript area. */
export function ExtensionDialogs({
  requests,
  onAnswer,
}: {
  requests: UiRequest[];
  onAnswer: (
    requestId: string,
    reply: { kind: "value" | "confirmed" | "cancelled"; value?: string },
  ) => void;
}) {
  if (requests.length === 0) return null;
  return (
    <div className="dialogs">
      {requests.map((request) => (
        <Dialog key={request.id} request={request} onAnswer={onAnswer} />
      ))}
    </div>
  );
}

function Dialog({
  request,
  onAnswer,
}: {
  request: UiRequest;
  onAnswer: (
    requestId: string,
    reply: { kind: "value" | "confirmed" | "cancelled"; value?: string },
  ) => void;
}) {
  const [value, setValue] = useState(request.prefill ?? "");
  const title = request.title || request.message || request.method;

  if (request.method === "select") {
    return (
      <div className="dialog">
        <div className="dialog-title">{title}</div>
        <div className="dialog-options">
          {(request.options ?? []).map((option) => (
            <button
              key={option}
              type="button"
              className="btn secondary"
              onClick={() => onAnswer(request.id, { kind: "value", value: option })}
            >
              {option}
            </button>
          ))}
          <button
            type="button"
            className="btn ghost"
            onClick={() => onAnswer(request.id, { kind: "cancelled" })}
          >
            取消
          </button>
        </div>
      </div>
    );
  }

  if (request.method === "confirm") {
    return (
      <div className="dialog">
        <div className="dialog-title">{title}</div>
        {request.message && <div className="dialog-message">{request.message}</div>}
        <div className="dialog-options">
          <button
            type="button"
            className="btn primary"
            onClick={() => onAnswer(request.id, { kind: "confirmed", value: "true" })}
          >
            确认
          </button>
          <button
            type="button"
            className="btn secondary"
            onClick={() => onAnswer(request.id, { kind: "confirmed", value: "false" })}
          >
            取消
          </button>
        </div>
      </div>
    );
  }

  if (request.method === "input" || request.method === "editor") {
    const multiline = request.method === "editor";
    return (
      <div className="dialog">
        <div className="dialog-title">{title}</div>
        {multiline ? (
          <textarea
            className="dialog-input"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            rows={6}
            autoFocus
          />
        ) : (
          <input
            className="dialog-input"
            value={value}
            placeholder={request.placeholder}
            onChange={(event) => setValue(event.target.value)}
            autoFocus
            onKeyDown={(event) => {
              if (event.key === "Enter") onAnswer(request.id, { kind: "value", value });
            }}
          />
        )}
        <div className="dialog-options">
          <button
            type="button"
            className="btn primary"
            onClick={() => onAnswer(request.id, { kind: "value", value })}
          >
            提交
          </button>
          <button
            type="button"
            className="btn ghost"
            onClick={() => onAnswer(request.id, { kind: "cancelled" })}
          >
            取消
          </button>
        </div>
      </div>
    );
  }

  return null;
}

export { api };
