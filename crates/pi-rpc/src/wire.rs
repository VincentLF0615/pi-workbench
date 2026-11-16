//! The three record families pi writes to stdout, plus the catch-all used for
//! records we do not recognize.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{events::PiEvent, ui::UiRequest};

/// Reply to one command. `id` echoes the command's `id`; a parse error reply
/// has no id.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Response {
    #[serde(default)]
    pub id: Option<String>,
    pub command: String,
    #[serde(default)]
    pub success: bool,
    #[serde(default)]
    pub data: Option<Value>,
    #[serde(default)]
    pub error: Option<String>,
}

/// One parsed stdout record.
#[derive(Debug, Clone, PartialEq)]
pub enum Incoming {
    Response(Response),
    Event(PiEvent),
    Ui(Box<UiRequest>),
    /// A record we could not classify. Kept for diagnostics; never fatal.
    Unknown(Value),
}

/// Classify one JSON value from pi's stdout.
pub fn parse_incoming(value: Value) -> Incoming {
    match value.get("type").and_then(Value::as_str) {
        Some("response") => match serde_json::from_value::<Response>(value.clone()) {
            Ok(response) => Incoming::Response(response),
            Err(_) => Incoming::Unknown(value),
        },
        Some("extension_ui_request") => match serde_json::from_value::<UiRequest>(value.clone()) {
            Ok(request) => Incoming::Ui(Box::new(request)),
            Err(_) => Incoming::Unknown(value),
        },
        _ => match serde_json::from_value::<PiEvent>(value.clone()) {
            Ok(event) => Incoming::Event(event),
            Err(_) => Incoming::Unknown(value),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn classifies_responses() {
        let incoming = parse_incoming(json!({
            "id": "req-1",
            "type": "response",
            "command": "get_state",
            "success": true,
            "data": {"model": {"id": "x"}}
        }));
        match incoming {
            Incoming::Response(response) => {
                assert_eq!(response.id.as_deref(), Some("req-1"));
                assert!(response.success);
                assert_eq!(response.data.unwrap()["model"]["id"], "x");
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn classifies_parse_error_response_without_id() {
        let incoming = parse_incoming(json!({
            "type": "response",
            "command": "parse",
            "success": false,
            "error": "Failed to parse command: boom"
        }));
        match incoming {
            Incoming::Response(response) => {
                assert!(response.id.is_none());
                assert!(!response.success);
                assert!(response.error.is_some());
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn classifies_ui_and_events_and_unknown() {
        assert!(matches!(
            parse_incoming(json!({
                "type": "extension_ui_request",
                "id": "u1",
                "method": "notify",
                "message": "hi"
            })),
            Incoming::Ui(_)
        ));
        assert!(matches!(
            parse_incoming(json!({"type": "agent_start"})),
            Incoming::Event(PiEvent::AgentStart)
        ));
        assert!(matches!(
            parse_incoming(json!({"type": "some_future_event", "x": 1})),
            Incoming::Unknown(_)
        ));
    }
}
