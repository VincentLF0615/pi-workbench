//! Typed view of the session events pi writes to stdout.
//!
//! The wire format is documented in pi's `docs/json.md` (installed copy under
//! `@earendil-works/pi-coding-agent/docs/`). Streaming payloads
//! (`message`, `partialResult`, `result`, nested provider events) stay as
//! `serde_json::Value` in this layer: the UI owns rendering, and keeping the
//! protocol layer tolerant avoids breaking on additive pi changes.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// One session event from pi. Unknown event types are returned as
/// [`Incoming::Unknown`](crate::wire::Incoming::Unknown) instead of failing.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum PiEvent {
    AgentStart,
    AgentEnd {
        #[serde(default)]
        messages: Vec<Value>,
        #[serde(default)]
        will_retry: bool,
    },
    AgentSettled {
        #[serde(default)]
        aborted: bool,
    },
    TurnStart,
    TurnEnd {
        #[serde(default)]
        message: Value,
        #[serde(default)]
        tool_results: Vec<Value>,
    },
    MessageStart {
        #[serde(default)]
        message: Value,
    },
    MessageUpdate {
        #[serde(default)]
        usage: Value,
        #[serde(default)]
        assistant_message_event: Value,
    },
    MessageEnd {
        #[serde(default)]
        message: Value,
    },
    ToolExecutionStart {
        tool_call_id: String,
        tool_name: String,
        #[serde(default)]
        args: Value,
    },
    ToolExecutionUpdate {
        tool_call_id: String,
        tool_name: String,
        #[serde(default)]
        args: Value,
        #[serde(default)]
        partial_result: Value,
    },
    ToolExecutionEnd {
        tool_call_id: String,
        tool_name: String,
        #[serde(default)]
        result: Value,
        #[serde(default)]
        is_error: bool,
        #[serde(default)]
        duration_ms: Option<u64>,
    },
    QueueUpdate {
        #[serde(default)]
        steering: Vec<String>,
        #[serde(default)]
        follow_up: Vec<String>,
    },
    EntryAppended {
        #[serde(default)]
        entry: Value,
    },
    SessionInfoChanged {
        #[serde(default)]
        name: Option<String>,
    },
    ThinkingLevelChanged {
        level: String,
    },
    CompactionStart {
        reason: String,
    },
    CompactionEnd {
        reason: String,
        #[serde(default)]
        result: Option<Value>,
        #[serde(default)]
        aborted: bool,
        #[serde(default)]
        will_retry: bool,
        #[serde(default)]
        error_message: Option<String>,
    },
    AutoRetryStart {
        attempt: u32,
        max_attempts: u32,
        delay_ms: u64,
        #[serde(default)]
        error_message: String,
    },
    AutoRetryEnd {
        success: bool,
        attempt: u32,
        #[serde(default)]
        final_error: Option<String>,
    },
    SummarizationRetryScheduled {
        attempt: u32,
        max_attempts: u32,
        delay_ms: u64,
        #[serde(default)]
        error_message: String,
    },
    SummarizationRetryAttemptStart {
        #[serde(default)]
        source: String,
        #[serde(default)]
        reason: Option<String>,
    },
    SummarizationRetryFinished,
    BashExecutionUpdate {
        #[serde(default)]
        id: Option<String>,
        delta: String,
    },
    ExtensionError {
        #[serde(default)]
        extension_path: String,
        #[serde(default)]
        event: String,
        error: String,
    },
}

impl PiEvent {
    /// Stable name of the event for logging and UI dispatch.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::AgentStart => "agent_start",
            Self::AgentEnd { .. } => "agent_end",
            Self::AgentSettled { .. } => "agent_settled",
            Self::TurnStart => "turn_start",
            Self::TurnEnd { .. } => "turn_end",
            Self::MessageStart { .. } => "message_start",
            Self::MessageUpdate { .. } => "message_update",
            Self::MessageEnd { .. } => "message_end",
            Self::ToolExecutionStart { .. } => "tool_execution_start",
            Self::ToolExecutionUpdate { .. } => "tool_execution_update",
            Self::ToolExecutionEnd { .. } => "tool_execution_end",
            Self::QueueUpdate { .. } => "queue_update",
            Self::EntryAppended { .. } => "entry_appended",
            Self::SessionInfoChanged { .. } => "session_info_changed",
            Self::ThinkingLevelChanged { .. } => "thinking_level_changed",
            Self::CompactionStart { .. } => "compaction_start",
            Self::CompactionEnd { .. } => "compaction_end",
            Self::AutoRetryStart { .. } => "auto_retry_start",
            Self::AutoRetryEnd { .. } => "auto_retry_end",
            Self::SummarizationRetryScheduled { .. } => "summarization_retry_scheduled",
            Self::SummarizationRetryAttemptStart { .. } => "summarization_retry_attempt_start",
            Self::SummarizationRetryFinished => "summarization_retry_finished",
            Self::BashExecutionUpdate { .. } => "bash_execution_update",
            Self::ExtensionError { .. } => "extension_error",
        }
    }
}

/// Type name of the nested provider event in `message_update`.
pub fn assistant_event_type(value: &Value) -> Option<&str> {
    value.get("type").and_then(Value::as_str)
}

/// Convenience accessor for a text delta, if this is one.
pub fn text_delta(value: &Value) -> Option<(&str, u32)> {
    if assistant_event_type(value) != Some("text_delta") {
        return None;
    }
    let delta = value.get("delta").and_then(Value::as_str)?;
    let index = value
        .get("contentIndex")
        .and_then(Value::as_u64)
        .unwrap_or(0) as u32;
    Some((delta, index))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn parse(value: Value) -> PiEvent {
        serde_json::from_value(value).expect("event should parse")
    }

    #[test]
    fn parses_lifecycle_events() {
        assert_eq!(parse(json!({"type": "agent_start"})), PiEvent::AgentStart);
        assert_eq!(
            parse(json!({"type": "agent_settled", "aborted": false})),
            PiEvent::AgentSettled { aborted: false }
        );
        assert_eq!(parse(json!({"type": "turn_start"})), PiEvent::TurnStart);
    }

    #[test]
    fn parses_tool_events_with_camel_case_fields() {
        let event = parse(json!({
            "type": "tool_execution_end",
            "toolCallId": "call_1",
            "toolName": "bash",
            "result": {"content": []},
            "isError": false,
            "durationMs": 42
        }));
        match event {
            PiEvent::ToolExecutionEnd {
                tool_call_id,
                tool_name,
                is_error,
                duration_ms,
                ..
            } => {
                assert_eq!(tool_call_id, "call_1");
                assert_eq!(tool_name, "bash");
                assert!(!is_error);
                assert_eq!(duration_ms, Some(42));
            }
            other => panic!("unexpected event: {other:?}"),
        }
    }

    #[test]
    fn parses_compaction_and_retry_events() {
        assert_eq!(
            parse(json!({"type": "compaction_start", "reason": "threshold"})),
            PiEvent::CompactionStart {
                reason: "threshold".into()
            }
        );
        let retry = parse(json!({
            "type": "auto_retry_start",
            "attempt": 1,
            "maxAttempts": 3,
            "delayMs": 2000,
            "errorMessage": "529 overloaded"
        }));
        assert_eq!(
            retry,
            PiEvent::AutoRetryStart {
                attempt: 1,
                max_attempts: 3,
                delay_ms: 2000,
                error_message: "529 overloaded".into()
            }
        );
    }

    #[test]
    fn extracts_text_deltas() {
        let update = json!({"type": "text_delta", "contentIndex": 0, "delta": "Hello"});
        assert_eq!(text_delta(&update), Some(("Hello", 0)));
        assert_eq!(assistant_event_type(&update), Some("text_delta"));
        assert_eq!(text_delta(&json!({"type": "thinking_delta"})), None);
    }
}
