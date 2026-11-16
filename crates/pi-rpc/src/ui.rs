//! Extension UI subprotocol.
//!
//! Extensions can ask the client for input. Dialog methods (`select`,
//! `confirm`, `input`, `editor`) block until the client answers with the same
//! `id`; when the request carries a `timeout`, pi resolves it on its own, so
//! the client never needs to track deadlines. Fire-and-forget methods
//! (`notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`) must
//! not be answered.

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiRequest {
    pub id: String,
    pub method: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub options: Vec<String>,
    #[serde(default)]
    pub placeholder: Option<String>,
    #[serde(default)]
    pub prefill: Option<String>,
    /// Milliseconds; pi auto-resolves with a default when it expires.
    #[serde(default)]
    pub timeout: Option<u64>,
    #[serde(default)]
    pub notify_type: Option<String>,
    #[serde(default)]
    pub status_key: Option<String>,
    #[serde(default)]
    pub status_text: Option<String>,
    #[serde(default)]
    pub widget_key: Option<String>,
    #[serde(default)]
    pub widget_lines: Vec<String>,
    #[serde(default)]
    pub widget_placement: Option<String>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl UiRequest {
    /// `true` for methods that require an `extension_ui_response`.
    pub fn is_dialog(&self) -> bool {
        matches!(
            self.method.as_str(),
            "select" | "confirm" | "input" | "editor"
        )
    }

    /// Human readable text for notifications and dialog titles.
    pub fn summary(&self) -> String {
        self.title
            .clone()
            .or_else(|| self.message.clone())
            .or_else(|| self.status_text.clone())
            .or_else(|| self.text.clone())
            .unwrap_or_else(|| self.method.clone())
    }
}

/// Answer for a dialog request.
#[derive(Debug, Clone, PartialEq)]
pub enum UiReply {
    /// `select`, `input`, `editor`
    Value(String),
    /// `confirm`
    Confirmed(bool),
    /// Dialog dismissed by the user.
    Cancelled,
}

impl UiReply {
    pub fn to_record(&self, id: &str) -> Value {
        match self {
            Self::Value(value) => json!({
                "type": "extension_ui_response",
                "id": id,
                "value": value,
            }),
            Self::Confirmed(confirmed) => json!({
                "type": "extension_ui_response",
                "id": id,
                "confirmed": confirmed,
            }),
            Self::Cancelled => json!({
                "type": "extension_ui_response",
                "id": id,
                "cancelled": true,
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_dialog_request_and_keeps_unknown_fields() {
        let request: UiRequest = serde_json::from_value(json!({
            "type": "extension_ui_request",
            "id": "u1",
            "method": "select",
            "title": "Allow dangerous command?",
            "options": ["Allow", "Block"],
            "timeout": 10000,
            "futureField": {"x": 1}
        }))
        .unwrap();
        assert!(request.is_dialog());
        assert_eq!(request.options, vec!["Allow", "Block"]);
        assert_eq!(request.timeout, Some(10_000));
        assert!(request.extra.contains_key("futureField"));
    }

    #[test]
    fn serializes_replies() {
        assert_eq!(
            UiReply::Value("Allow".into()).to_record("u1"),
            json!({"type": "extension_ui_response", "id": "u1", "value": "Allow"})
        );
        assert_eq!(
            UiReply::Confirmed(true).to_record("u2"),
            json!({"type": "extension_ui_response", "id": "u2", "confirmed": true})
        );
        assert_eq!(
            UiReply::Cancelled.to_record("u3"),
            json!({"type": "extension_ui_response", "id": "u3", "cancelled": true})
        );
    }
}
