use pi_rpc::{ClientEvent, Error, ImageContent, PiClient, SpawnOptions};
use serde_json::json;
use std::path::PathBuf;
use std::time::Duration;

fn spawn() -> (tempfile::TempDir, PiClient) {
    let dir = tempfile::tempdir().unwrap();
    let mock = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/support/mock-pi.cjs");
    let mut options = SpawnOptions::new(dir.path());
    options.executable = Some(mock);
    let client = PiClient::spawn(options).unwrap();
    client.get_state().unwrap();
    (dir, client)
}

#[test]
fn process_exit_fails_pending_without_waiting_for_timeout() {
    let (_dir, client) = spawn();
    let result =
        client.request_with_timeout(json!({"type":"exit_without_reply"}), Duration::from_secs(2));
    assert!(
        matches!(result, Err(Error::Closed) | Err(Error::Exited(_))),
        "{result:?}"
    );
    client.close().unwrap();
    client.close().unwrap();
}

#[test]
fn image_only_messages_reach_the_wire() {
    let (_dir, client) = spawn();
    let image = ImageContent {
        kind: "image".into(),
        data: "aGk=".into(),
        mime_type: "image/png".into(),
    };
    for command in ["prompt", "steer", "follow_up"] {
        let response = match command {
            "prompt" => client.prompt_with_images("", std::slice::from_ref(&image)),
            "steer" => client.steer_with_images("", std::slice::from_ref(&image)),
            _ => client.follow_up_with_images("", std::slice::from_ref(&image)),
        }
        .unwrap();
        assert_eq!(response["message"], "");
        assert_eq!(response["images"][0]["mimeType"], "image/png");
        assert_eq!(response["images"][0]["data"], "aGk=");
    }
    client.close().unwrap();
}

#[test]
fn stderr_is_bounded_and_dialogs_still_arrive() {
    let (_dir, client) = spawn();
    let events = client.subscribe();
    client.request(json!({"type":"stderr_large"})).unwrap();
    client.request(json!({"type":"emit_dialog"})).unwrap();
    assert!(matches!(
        events.recv_timeout(Duration::from_secs(2)).unwrap(),
        ClientEvent::Ui(_)
    ));
    std::thread::sleep(Duration::from_millis(100));
    let logs = client.stderr_tail();
    assert!(logs.iter().any(|line| line.contains("truncated")));
    assert!(logs.iter().any(|line| line == "small log"));
    assert!(logs.len() <= 200);
    assert!(logs.iter().map(String::len).sum::<usize>() <= 1024 * 1024);
    client.close().unwrap();
}
