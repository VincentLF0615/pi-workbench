import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import type { PiModel } from "../lib/types";

const levelOrder = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const emptyLevels: string[] = [];
const compatibleLevel = (requested: string, available: string[]) => {
  if (available.includes(requested)) return requested;
  const index = levelOrder.indexOf(requested);
  if (index < 0) return available[0] ?? "off";
  return levelOrder.slice(index).find(level => available.includes(level)) ??
    levelOrder.slice(0, index).reverse().find(level => available.includes(level)) ?? available[0] ?? "off";
};
const contextLabel = (value?: number) => value ? `${Math.round(value / 1000)}K 上下文` : "";

/** Search Pi's actual model registry and commit the selection through RPC. */
export function ModelPicker({ sessionId, model, thinkingLevel, busy, onApply }: {
  sessionId: string | null;
  model?: PiModel | null;
  thinkingLevel?: string;
  busy: boolean;
  onApply: (provider: string, modelId: string, thinkingLevel: string) => Promise<void>;
}) {
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<PiModel[]>([]);
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState("");
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [draftModel, setDraftModel] = useState<{ provider: string; id: string } | null>(null);
  const [draftThinking, setDraftThinking] = useState("off");
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const request = useRef(0);

  const load = useCallback(async () => {
    if (!sessionId) return;
    const ticket = ++request.current;
    setLoading(true);
    setError(null);
    try {
      const result = await api.getAvailableModels(sessionId);
      if (ticket === request.current) setModels(result.models ?? []);
    } catch (cause) {
      if (ticket === request.current) setError(`无法读取模型：${String(cause)}`);
    } finally {
      if (ticket === request.current) setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    setOpen(false);
    setModels([]);
    return () => { request.current += 1; };
  }, [sessionId]);

  const show = useCallback(() => {
    if (!sessionId) return;
    setQuery("");
    setProvider("");
    setHighlight(0);
    setDraftModel(model ? { provider: model.provider, id: model.id } : null);
    setDraftThinking(thinkingLevel ?? "off");
    setOpen(true);
    void load();
  }, [sessionId, load, model?.provider, model?.id, thinkingLevel]);

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "m") {
        event.preventDefault();
        show();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [show]);

  useEffect(() => {
    if (!open) return;
    search.current?.focus();
    return () => trigger.current?.focus();
  }, [open]);

  const providers = useMemo(() => [...new Set(models.map(entry => entry.provider))].sort(), [models]);
  const filtered = useMemo(() => {
    const words = query.toLowerCase().trim().split(/\s+/);
    return models.filter(entry => (!provider || entry.provider === provider) &&
      words.every(word => `${entry.name ?? ""} ${entry.id} ${entry.provider}`.toLowerCase().includes(word)))
      .sort((a, b) => Number(b.id === model?.id && b.provider === model?.provider) -
        Number(a.id === model?.id && a.provider === model?.provider));
  }, [models, provider, query, model?.id, model?.provider]);
  const selectedModel = models.find(entry => entry.id === draftModel?.id && entry.provider === draftModel?.provider);
  const availableLevels = selectedModel?.supportedThinkingLevels ?? emptyLevels;

  useEffect(() => {
    if (open && availableLevels.length > 0 && !availableLevels.includes(draftThinking)) {
      setDraftThinking(compatibleLevel(draftThinking, availableLevels));
    }
  }, [open, availableLevels, draftThinking]);

  const choose = (entry: PiModel) => {
    if (busy || pending) return;
    setDraftModel({ provider: entry.provider, id: entry.id });
    setDraftThinking(level => compatibleLevel(level, entry.supportedThinkingLevels ?? emptyLevels));
    setError(null);
  };

  const confirm = async () => {
    if (busy || pending || !selectedModel || !availableLevels.includes(draftThinking)) return;
    setPending(true);
    setError(null);
    try {
      await onApply(selectedModel.provider, selectedModel.id, draftThinking);
      setOpen(false);
    } catch (cause) {
      setError(`切换失败：${String(cause)}`);
    } finally { setPending(false); }
  };

  return <div className="model-picker">
    <button ref={trigger} type="button" className="model-button" onClick={show} disabled={!sessionId}
      aria-haspopup="dialog" aria-expanded={open} title="选择模型（Ctrl+Shift+M）">
      <span className="model-trigger-label">选择模型</span>
      <span className="model-name">{model?.name || model?.id || "打开会话后选择"}</span>
    </button>
    {open && <div className="modal-backdrop model-backdrop" onMouseDown={event => {
      if (event.target === event.currentTarget && !pending) setOpen(false);
    }}>
      <div ref={dialog} className="model-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}
        onKeyDown={event => {
          if (event.key === "Escape") {
            event.stopPropagation();
            if (!pending) setOpen(false);
          }
          if (event.key === "Tab") {
            const focusable = [...dialog.current!.querySelectorAll<HTMLElement>('button:not(:disabled), input, select')];
            const first = focusable[0]; const last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
          }
        }}>
        <div className="model-dialog-heading"><div><h2 id={titleId}>选择模型</h2><p>选好模型和思考强度后，点击确定应用到当前会话</p></div>
          <button type="button" className="model-dismiss" aria-label="关闭模型选择" disabled={pending} onClick={() => setOpen(false)}>×</button>
        </div>
        <div className="model-search-row">
          <input ref={search} className="input model-search" placeholder="搜索模型名称、ID 或服务商…" value={query}
            aria-label="搜索模型" onChange={event => { setQuery(event.target.value); setHighlight(0); }}
            onKeyDown={event => {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const next = Math.max(0, Math.min(filtered.length - 1, highlight + (event.key === "ArrowDown" ? 1 : -1)));
                setHighlight(next);
                dialog.current?.querySelector(`[data-model-index="${next}"]`)?.scrollIntoView({ block: "nearest" });
              }
              if (event.key === "Enter" && filtered[highlight]) { event.preventDefault(); choose(filtered[highlight]); }
            }} />
          <select className="input model-provider-filter" value={provider} aria-label="筛选服务商" onChange={event => { setProvider(event.target.value); setHighlight(0); }}>
            <option value="">全部服务商</option>{providers.map(value => <option key={value}>{value}</option>)}
          </select>
        </div>
        <div className="model-results-heading"><span>{loading ? "正在读取模型…" : `${filtered.length} 个可用模型`}</span>
          <button className="link-button" type="button" onClick={() => void load()} disabled={loading || pending}>刷新列表</button>
        </div>
        {error && <div className="model-error" role="alert">{error}</div>}
        {busy && <div className="model-notice">当前任务正在运行，结束后即可切换模型。</div>}
        <div className="model-results" aria-label="可用模型" aria-busy={loading}>
          {!loading && filtered.length === 0 && <div className="model-no-results">{query ? "没有找到匹配的模型，试试其他关键词。" : "没有可用模型。请检查 Pi 的模型配置后刷新。"}</div>}
          {filtered.map((entry, index) => {
            const selected = entry.id === draftModel?.id && entry.provider === draftModel?.provider;
            const current = entry.id === model?.id && entry.provider === model?.provider;
            return <button type="button" key={`${entry.provider}/${entry.id}`} data-model-id={entry.id} data-model-index={index}
              className={`model-option ${selected ? "selected" : ""} ${highlight === index ? "highlighted" : ""}`}
              disabled={busy || pending} onClick={() => choose(entry)} aria-pressed={selected}>
              <span className="model-option-icon" aria-hidden="true">{selected ? "✓" : "◇"}</span>
              <span className="model-option-copy"><strong>{entry.name || entry.id}</strong><small>{entry.provider} / {entry.id}</small></span>
              <span className="model-option-details"><span>{contextLabel(entry.contextWindow)}</span><small>{current ? "当前使用" : selected ? "待应用" : entry.reasoning ? "支持思考" : ""}</small></span>
            </button>;
          })}
        </div>
        <div className="model-thinking"><span>思考强度</span>
          {!selectedModel ? <span className="model-thinking-note">{loading ? "正在读取模型能力…" : "请先选择模型"}</span> :
            selectedModel.reasoning !== true ? <span className="model-thinking-note">此模型不支持思考，使用关闭状态</span> :
              availableLevels.length === 0 ? <span className="model-thinking-note">此模型未提供可用思考档位，请刷新列表</span> :
                <div className="level-row">{availableLevels.map(level =>
                  <button key={level} type="button" className={`level-chip ${draftThinking === level ? "active" : ""}`}
                    disabled={pending || busy} aria-pressed={draftThinking === level}
                    onClick={() => setDraftThinking(level)}>{level}</button>)}</div>}
        </div>
        <div className="model-dialog-footer model-confirm-footer">
          <span>{pending ? "正在应用…" : selectedModel ? `${selectedModel.name || selectedModel.id} · ${draftThinking}` : "请选择模型"}</span>
          <div className="model-confirm-actions">
            <button type="button" className="btn secondary model-cancel" disabled={pending} onClick={() => setOpen(false)}>取消</button>
            <button type="button" className="btn primary model-confirm" disabled={pending || busy || loading || !selectedModel || !availableLevels.includes(draftThinking)}
              onClick={() => void confirm()}>{pending ? "应用中…" : "确定"}</button>
          </div>
        </div>
      </div>
    </div>}
  </div>;
}
