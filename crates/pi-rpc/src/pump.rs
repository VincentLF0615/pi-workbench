//! Batching event pump.
//!
//! pi emits many small events (one per streamed delta, one per tool update).
//! Emitting each of them straight to a UI would flood the bridge, so this
//! module accumulates events for a short window and hands the batch to a sink.
//!
//! The pump is deliberately free of any UI framework dependency: it takes a
//! receiver and a callback, which makes the batching rules testable and lets
//! any frontend (Tauri, a local web server, a CLI) reuse it.

use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::client::ClientEvent;

/// How long the pump may accumulate events before flushing a batch.
pub const BATCH_WINDOW: Duration = Duration::from_millis(16);
/// Upper bound on events in one batch, so a busy session cannot stall the UI.
pub const BATCH_MAX: usize = 64;
/// How long to wait for the first event when nothing is pending.
const IDLE_WAIT: Duration = Duration::from_millis(250);

/// Flatten one client event into a small record for the frontend.
pub fn event_payload(event: &ClientEvent) -> Value {
    match event {
        ClientEvent::Pi(event) => json!({ "kind": "pi", "event": event }),
        ClientEvent::Ui(request) => json!({ "kind": "ui", "event": request }),
        ClientEvent::Exited(code) => json!({ "kind": "exited", "code": code }),
        ClientEvent::ProtocolError(message) => {
            json!({ "kind": "protocolError", "message": message })
        }
    }
}

/// Read events until the channel closes, calling `sink` with each batch.
///
/// The batch is a JSON array of [`event_payload`] records. `sink` is called at
/// most once per window, and never with an empty batch.
pub fn run_pump<S>(events: &Receiver<ClientEvent>, mut sink: S)
where
    S: FnMut(&[Value]),
{
    let mut batch: Vec<Value> = Vec::new();
    let mut deadline: Option<Instant> = None;

    loop {
        let wait = deadline
            .map(|deadline| deadline.saturating_duration_since(Instant::now()))
            .unwrap_or(IDLE_WAIT)
            .max(Duration::from_millis(1));

        match events.recv_timeout(wait) {
            Ok(event) => {
                batch.push(event_payload(&event));
                if deadline.is_none() {
                    deadline = Some(Instant::now() + BATCH_WINDOW);
                }
                if batch.len() >= BATCH_MAX {
                    sink(&batch);
                    batch.clear();
                    deadline = None;
                }
            }
            Err(RecvTimeoutError::Timeout) => {
                if !batch.is_empty() {
                    sink(&batch);
                    batch.clear();
                }
                deadline = None;
            }
            Err(RecvTimeoutError::Disconnected) => {
                if !batch.is_empty() {
                    sink(&batch);
                }
                return;
            }
        }
    }
}

/// Payload shape the frontend receives: session id plus one batch of events.
pub fn batch_payload(session_id: &str, events: &[Value]) -> Value {
    json!({ "sessionId": session_id, "events": events })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::PiEvent;
    use serde_json::json;

    fn channel() -> (std::sync::mpsc::Sender<ClientEvent>, Receiver<ClientEvent>) {
        std::sync::mpsc::channel()
    }

    #[test]
    fn batches_events_into_one_call() {
        let (sender, receiver) = channel();
        sender.send(ClientEvent::Pi(PiEvent::AgentStart)).unwrap();
        sender
            .send(ClientEvent::Pi(PiEvent::AgentSettled { aborted: false }))
            .unwrap();
        sender.send(ClientEvent::Exited(Some(0))).unwrap();
        drop(sender);

        let mut calls = 0usize;
        let mut total = 0usize;
        run_pump(&receiver, |batch| {
            calls += 1;
            total += batch.len();
        });
        // All three arrive within one window, so they share a single call.
        assert_eq!(calls, 1);
        assert_eq!(total, 3);
    }

    #[test]
    fn flushs_a_partial_batch_when_the_channel_closes() {
        let (sender, receiver) = channel();
        sender.send(ClientEvent::Pi(PiEvent::AgentStart)).unwrap();
        drop(sender);

        let mut batches = Vec::new();
        run_pump(&receiver, |batch| batches.push(batch.len()));
        assert_eq!(batches, vec![1]);
    }

    #[test]
    fn payloads_are_tagged_by_kind() {
        assert_eq!(
            event_payload(&ClientEvent::Pi(PiEvent::AgentStart)),
            json!({ "kind": "pi", "event": { "type": "agent_start" } })
        );
        assert_eq!(
            event_payload(&ClientEvent::Exited(Some(3))),
            json!({ "kind": "exited", "code": 3 })
        );
        assert_eq!(
            event_payload(&ClientEvent::ProtocolError("boom".into())),
            json!({ "kind": "protocolError", "message": "boom" })
        );
        let ui = event_payload(&ClientEvent::Ui(Box::new(
            serde_json::from_value(json!({
                "id": "u1",
                "method": "notify",
                "options": []
            }))
            .unwrap(),
        )));
        assert_eq!(ui["kind"], "ui");
        assert_eq!(ui["event"]["id"], "u1");
    }

    #[test]
    fn batch_payload_carries_the_session_id() {
        let payload = batch_payload("s1", &[json!({"kind": "exited", "code": 0})]);
        assert_eq!(payload["sessionId"], "s1");
        assert_eq!(payload["events"].as_array().unwrap().len(), 1);
    }
}
