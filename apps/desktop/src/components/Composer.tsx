import { useRef, useState } from "react";
import { api } from "../lib/api";
import { readImage, validateImages } from "../lib/images";
import type {
  Draft,
  ImageContent,
  PiModel,
  PiQueues,
  UiRequest,
} from "../lib/types";

export function Composer({
  sessionId,
  busy,
  disabled = false,
  model,
  draft,
  queues,
  pendingMessageCount = 0,
  stopping = false,
  footer = null,
  onDraftChange,
  onSend,
  onSteer,
  onFollowUp,
  onAbort,
}: {
  sessionId: string | null;
  busy: boolean;
  disabled?: boolean;
  model?: PiModel | null;
  draft: Draft;
  queues: PiQueues | null;
  pendingMessageCount?: number;
  stopping?: boolean;
  /** Extra controls rendered at the composer's bottom-right (model picker). */
  footer?: React.ReactNode;
  onDraftChange: (draft: Draft) => void;
  onSend: (text: string, images: ImageContent[]) => Promise<void>;
  onSteer: (text: string, images: ImageContent[]) => Promise<void>;
  onFollowUp: (text: string, images: ImageContent[]) => Promise<void>;
  onAbort: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const change = (next: Draft) => {
    draftRef.current = next;
    onDraftChange(next);
  };
  const submit = async (queueFollowUp = false) => {
    if (
      pending ||
      reading ||
      disabled ||
      stopping ||
      !sessionId ||
      (!draft.text.trim() && !draft.images.length)
    )
      return;
    setError(null);
    try {
      validateImages(draft.images);
      if (
        draft.images.length &&
        (!Array.isArray(model?.input) || !model.input.includes("image"))
      ) {
        throw new Error("当前模型不支持图片，请切换支持图片的模型");
      }
      setPending(true);
      const content = { text: draft.text.trim(), images: draft.images };
      const action = busy ? (queueFollowUp ? onFollowUp : onSteer) : onSend;
      await action(content.text, content.images);
      change({ text: "", images: [] });
    } catch (cause) {
      setError(String(cause));
    } finally {
      setPending(false);
    }
  };

  const attach = async (files: File[]) => {
    if (pending || reading || disabled || stopping) return;
    setReading(true);
    setError(null);
    try {
      const added = await Promise.all(files.map(readImage));
      const images = [...draftRef.current.images, ...added];
      validateImages(images);
      change({ ...draftRef.current, images });
    } catch (cause) {
      setError(String(cause));
    } finally {
      setReading(false);
    }
  };

  const cannotSubmit =
    !sessionId ||
    disabled ||
    pending ||
    reading ||
    stopping ||
    (!draft.text.trim() && !draft.images.length);

  return (
    <div
      className="composer"
      onDragOver={(event) => {
        event.preventDefault();
      }}
      onDrop={(event) => {
        event.preventDefault();
        void attach(Array.from(event.dataTransfer.files));
      }}
    >
      <QueueSummary queues={queues} pendingMessageCount={pendingMessageCount} />
      {draft.images.length > 0 && (
        <div className="composer-images">
          {draft.images.map((image, index) => (
            <div key={index} className="composer-image">
              <img
                src={`data:${image.mimeType};base64,${image.data}`}
                alt={`attachment ${index + 1}`}
              />
              <button
                type="button"
                className="composer-image-remove"
                disabled={pending || reading}
                aria-label="remove image"
                onClick={() =>
                  change({
                    ...draft,
                    images: draft.images.filter((_, i) => i !== index),
                  })
                }
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      {error && (
        <div role="alert" className="row-error">
          {error}
        </div>
      )}
      <div className="composer-main">
        <textarea
          className="composer-input"
          aria-label="消息"
          placeholder={
            sessionId
              ? "输入消息，Enter 发送，Shift+Enter 换行"
              : "先打开一个会话"
          }
          value={draft.text}
          rows={3}
          disabled={!sessionId || disabled || pending || stopping}
          onChange={(event) => change({ ...draft, text: event.target.value })}
          onPaste={(event) => {
            const files = Array.from(event.clipboardData.files).filter((file) =>
              file.type.startsWith("image/"),
            );
            if (files.length) {
              event.preventDefault();
              void attach(files);
            }
          }}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        <div className="composer-actions">
          <div className="composer-hint-row">
            <span className="composer-hint">
              {stopping
                ? "正在停止并取回排队文字…"
                : reading
                  ? "正在读取图片…"
                  : busy
                    ? "Enter 追加指令 · Esc 停止"
                    : "Enter 发送"}
            </span>
            {busy && (
              <button
                type="button"
                className="btn ghost"
                onClick={onAbort}
                disabled={stopping}
                title="清空队列，将排队文字取回输入框，并中断当前任务；排队图片需重新添加"
              >
                {stopping ? "停止中…" : "停止"}
              </button>
            )}
          </div>
          <div className="composer-submit-actions">
            {busy && (
              <button
                type="button"
                className="btn ghost"
                onClick={() => void submit(true)}
                disabled={cannotSubmit}
                title="等当前任务及其工具调用全部结束后再处理这条消息"
              >
                稍后跟进
              </button>
            )}
            <button
              type="button"
              className={`btn ${busy ? "secondary" : "primary"}`}
              onClick={() => void submit()}
              disabled={cannotSubmit}
              title={
                busy
                  ? "当前响应和工具调用结束后、下一次模型请求前处理这条指令"
                  : "发送消息"
              }
            >
              {pending ? "提交中…" : busy ? "追加指令" : "发送"}
            </button>
          </div>
        </div>
      </div>
      {footer && <div className="composer-footer">{footer}</div>}
    </div>
  );
}

function QueueSummary({
  queues,
  pendingMessageCount,
}: {
  queues: PiQueues | null;
  pendingMessageCount: number;
}) {
  const count = queues
    ? queues.steering.length + queues.followUp.length
    : Math.max(0, pendingMessageCount);
  if (count === 0) return null;

  return (
    <details className="queue-summary">
      <summary>
        <span>排队消息 · {count}</span>
        <span className="queue-summary-hint">
          {queues ? "展开查看" : "等待队列详情"}
        </span>
      </summary>
      {queues ? (
        <div className="queue-groups">
          <QueueGroup title="追加指令" items={queues.steering} />
          <QueueGroup title="稍后跟进" items={queues.followUp} />
        </div>
      ) : (
        <p className="queue-unknown">
          Pi 尚未提供排队文本；停止时仍会尝试取回。
        </p>
      )}
      <p className="queue-note">停止会取回排队文字；排队图片需重新添加。</p>
    </details>
  );
}

function QueueGroup({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <section className="queue-group">
      <h3>{title}</h3>
      <ol>
        {items.map((text, index) => (
          <li key={`${index}:${text}`}>
            <div className="queue-text">{text}</div>
          </li>
        ))}
      </ol>
    </section>
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
  ) => void | Promise<void>;
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
  ) => void | Promise<void>;
}) {
  const [value, setValue] = useState(request.prefill ?? "");
  const title = request.title || request.message || request.method;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const answer = async (reply: {
    kind: "value" | "confirmed" | "cancelled";
    value?: string;
  }) => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await onAnswer(request.id, reply);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setPending(false);
    }
  };

  if (request.method === "select") {
    return (
      <div className="dialog">
        <div className="dialog-title">{title}</div>
        {error && (
          <div role="alert" className="row-error">
            {error}
          </div>
        )}
        <div className="dialog-options">
          {(request.options ?? []).map((option) => (
            <button
              key={option}
              type="button"
              disabled={pending}
              className="btn secondary"
              onClick={() => void answer({ kind: "value", value: option })}
            >
              {option}
            </button>
          ))}
          <button
            type="button"
            disabled={pending}
            className="btn ghost"
            onClick={() => void answer({ kind: "cancelled" })}
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
        {error && (
          <div role="alert" className="row-error">
            {error}
          </div>
        )}
        {request.message && (
          <div className="dialog-message">{request.message}</div>
        )}
        <div className="dialog-options">
          <button
            type="button"
            disabled={pending}
            className="btn primary"
            onClick={() => void answer({ kind: "confirmed", value: "true" })}
          >
            确认
          </button>
          <button
            type="button"
            disabled={pending}
            className="btn secondary"
            onClick={() => void answer({ kind: "confirmed", value: "false" })}
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
        {error && (
          <div role="alert" className="row-error">
            {error}
          </div>
        )}
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
              if (event.key === "Enter") void answer({ kind: "value", value });
            }}
          />
        )}
        <div className="dialog-options">
          <button
            type="button"
            disabled={pending}
            className="btn primary"
            onClick={() => void answer({ kind: "value", value })}
          >
            提交
          </button>
          <button
            type="button"
            disabled={pending}
            className="btn ghost"
            onClick={() => void answer({ kind: "cancelled" })}
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
