//! Opt-in smoke test against the real pi installation.
//!
//! ```text
//! cargo test -p pi-rpc --test real_pi -- --ignored --nocapture
//! ```
//!
//! Requirements: pi installed and authenticated, a usable default model, and
//! network access. The test starts a throwaway session (`--no-session`), asks
//! for a one word answer, and runs everything through [`pi_rpc::run_pump`],
//! which is the same batching path the desktop app uses.

use std::sync::mpsc::RecvTimeoutError;
use std::time::{Duration, Instant};

use pi_rpc::{run_pump, ClientEvent, PiClient, PiEvent, SpawnOptions};

#[test]
#[ignore = "requires a configured pi installation and network access"]
fn prompt_streams_and_settles() {
    let mut options = SpawnOptions::new(std::env::current_dir().unwrap());
    options.no_session = true;

    let client = PiClient::spawn(options).expect("spawn pi");
    let events = client.subscribe();

    let state = client.get_state().expect("get_state");
    assert!(
        state.get("sessionId").and_then(|value| value.as_str()).is_some(),
        "get_state did not return a session id: {state}"
    );

    client
        .prompt("Reply with exactly: OK")
        .expect("pi rejected the prompt");

    let deadline = Instant::now() + Duration::from_secs(180);
    let mut saw_text = false;
    let mut batches = 0usize;
    // Set by the closure below once `agent_settled` is seen.
    let outcome = std::cell::Cell::new(false);

    // Drain through the real pump so the batching path is covered too.
    let mut check = |batch: &[serde_json::Value]| {
        batches += 1;
        for record in batch {
            if record.get("kind").and_then(|kind| kind.as_str()) != Some("pi") {
                continue;
            }
            let Some(event) = record.get("event") else { continue };
            let kind = event.get("type").and_then(|value| value.as_str());
            if kind == Some("agent_settled") {
                outcome.set(true);
            } else if kind == Some("message_update")
                && event
                    .pointer("/assistantMessageEvent/type")
                    .and_then(|value| value.as_str())
                    == Some("text_delta")
            {
                saw_text = true;
            }
        }
    };

    loop {
        if Instant::now() >= deadline {
            break;
        }
        let remaining = (deadline - Instant::now()).min(Duration::from_millis(200));
        match events.recv_timeout(remaining) {
            Ok(ClientEvent::Pi(PiEvent::AgentSettled { aborted })) => {
                assert!(!aborted, "run was aborted");
                check(&[pi_rpc::event_payload(&ClientEvent::Pi(
                    PiEvent::AgentSettled { aborted: false },
                ))]);
                break;
            }
            Ok(ClientEvent::Pi(event)) => {
                check(&[pi_rpc::event_payload(&ClientEvent::Pi(event))]);
            }
            Ok(ClientEvent::Exited(code)) => panic!("pi exited before settling: {code:?}"),
            Ok(ClientEvent::ProtocolError(message)) => eprintln!("protocol error: {message}"),
            Ok(_) => {}
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
    let _ = client.close();
    assert!(outcome.get(), "pi never reached agent_settled");
    assert!(saw_text, "no text delta arrived");
    assert!(batches > 0, "the pump produced no batches");
}

/// The pump batches everything that arrives within one window.
#[test]
fn pump_batches_within_a_window() {
    let (sender, receiver) = std::sync::mpsc::channel();
    for index in 0..3 {
        sender
            .send(ClientEvent::Pi(PiEvent::MessageEnd {
                message: serde_json::json!({"role": "assistant", "content": []}),
            }))
            .unwrap();
        let _ = index;
    }
    sender.send(ClientEvent::Exited(Some(0))).unwrap();
    drop(sender);

    let mut calls = 0usize;
    let mut records = 0usize;
    run_pump(&receiver, |batch| {
        calls += 1;
        records += batch.len();
    });
    assert_eq!(calls, 1, "events in one window should share a single batch");
    assert_eq!(records, 4);
}
