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

use std::time::Duration;

use pi_rpc::{run_pump, ClientEvent, PiClient, PiEvent, SpawnOptions};

#[test]
#[ignore = "requires a configured pi installation and network access"]
fn prompt_streams_and_settles() {
    let mut options = SpawnOptions::new(std::env::current_dir().unwrap());
    options.no_session = true;
    let client = PiClient::spawn(options).expect("spawn pi");
    let events = client.subscribe();
    let state = client.get_state().expect("get_state");
    assert!(state["sessionId"].is_string());
    let (sender, receiver) = std::sync::mpsc::channel();
    let worker = std::thread::spawn(move || {
        let mut saw_text = false;
        let mut batches = 0;
        run_pump(&events, |batch| {
            batches += 1;
            for record in batch {
                if record["kind"] == "exited" {
                    let _ = sender.send(Err("pi exited".to_string()));
                }
                let event = &record["event"];
                if event["type"] == "message_update"
                    && event["assistantMessageEvent"]["type"] == "text_delta"
                {
                    saw_text = true;
                }
                if event["type"] == "agent_settled" {
                    let result = if event["aborted"] == true {
                        Err("agent aborted".to_string())
                    } else {
                        Ok((saw_text, batches))
                    };
                    let _ = sender.send(result);
                }
            }
        });
    });
    client
        .prompt("Reply with exactly: OK")
        .expect("pi rejected prompt");
    let result = receiver.recv_timeout(Duration::from_secs(180));
    client.close().expect("close pi");
    worker.join().unwrap();
    let (saw_text, batches) = result.expect("pi never settled").expect("pi failed");
    assert!(saw_text, "no text delta arrived");
    assert!(batches > 0, "the actual pump must receive real events");
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
