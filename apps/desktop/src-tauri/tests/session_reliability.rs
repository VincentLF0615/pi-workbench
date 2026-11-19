use pi_rpc::{ClientEvent, PiEvent};
use pi_workbench_lib::{commands, session::SessionState};
use serde_json::json;
use std::path::PathBuf;
use std::sync::{Arc, mpsc};
use std::time::Duration;

fn mock() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../crates/pi-rpc/tests/support/mock-pi.cjs")
}
fn open(state: &Arc<SessionState>, dir: &std::path::Path, path: Option<PathBuf>) -> String {
    state.open_no_app(dir.into(), path, Some(mock())).unwrap()
}

#[test]
fn slow_mutation_does_not_block_other_sessions_or_abort() {
    let dir = tempfile::tempdir().unwrap();
    let state = Arc::new(SessionState::default());
    let a = open(&state, dir.path(), None);
    let b = open(&state, dir.path(), None);
    let events = state.with(&a, |c| Ok(c.subscribe())).unwrap();
    let worker_state = Arc::clone(&state);
    let worker_id = a.clone();
    let (done_tx, done_rx) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        let result = worker_state.with_mutation(&worker_id, |c| c.compact());
        done_tx.send(result).unwrap();
    });
    loop {
        if matches!(
            events.recv_timeout(Duration::from_secs(3)).unwrap(),
            ClientEvent::Pi(PiEvent::CompactionStart { .. })
        ) {
            break;
        }
    }
    state.with(&b, |c| c.get_state()).unwrap();
    assert!(
        matches!(done_rx.try_recv(), Err(mpsc::TryRecvError::Empty)),
        "another session waited for compaction"
    );
    state.with(&a, commands::stop_with_queue).unwrap();
    done_rx
        .recv_timeout(Duration::from_secs(2))
        .unwrap()
        .unwrap();
    worker.join().unwrap();
    state.shutdown();
}

#[test]
fn stop_recovers_queue_before_abort() {
    let dir = tempfile::tempdir().unwrap();
    let state = Arc::new(SessionState::default());
    let id = open(&state, dir.path(), None);
    state
        .with(&id, |client| {
            client.request(json!({
                "type": "seed_queue",
                "steering": ["adjust the current task"],
                "followUp": ["summarize afterwards"]
            }))
        })
        .unwrap();

    let outcome = state.with(&id, commands::stop_with_queue).unwrap();
    assert_eq!(outcome.steering, ["adjust the current task"]);
    assert_eq!(outcome.follow_up, ["summarize afterwards"]);
    assert_eq!(outcome.abort_error, None);
    let log = state
        .with(&id, |client| {
            client.request(json!({"type": "get_control_log"}))
        })
        .unwrap();
    assert_eq!(log["controlLog"], json!(["clear_queue", "abort"]));
    state.shutdown();
}

#[test]
fn clear_failure_does_not_abort() {
    let dir = tempfile::tempdir().unwrap();
    let state = Arc::new(SessionState::default());
    let id = open(&state, dir.path(), None);
    state
        .with(&id, |client| {
            client.request(json!({"type": "fail_clear_queue"}))
        })
        .unwrap();

    let error = state.with(&id, commands::stop_with_queue).unwrap_err();
    assert!(error.to_string().contains("尚未停止"));
    let log = state
        .with(&id, |client| {
            client.request(json!({"type": "get_control_log"}))
        })
        .unwrap();
    assert_eq!(log["controlLog"], json!(["clear_queue"]));
    state.shutdown();
}

#[test]
fn abort_failure_still_returns_recovered_text() {
    let dir = tempfile::tempdir().unwrap();
    let state = Arc::new(SessionState::default());
    let id = open(&state, dir.path(), None);
    state
        .with(&id, |client| {
            client.request(json!({
                "type": "seed_queue",
                "steering": ["recover me"],
                "followUp": []
            }))
        })
        .unwrap();
    state
        .with(&id, |client| client.request(json!({"type": "fail_abort"})))
        .unwrap();

    let outcome = state.with(&id, commands::stop_with_queue).unwrap();
    assert_eq!(outcome.steering, ["recover me"]);
    assert!(outcome.abort_error.is_some());
    let log = state
        .with(&id, |client| {
            client.request(json!({"type": "get_control_log"}))
        })
        .unwrap();
    assert_eq!(log["controlLog"], json!(["clear_queue", "abort"]));
    state.shutdown();
}

#[test]
fn branching_preserves_original_and_opens_a_distinct_writer() {
    let dir = tempfile::tempdir().unwrap();
    let state = Arc::new(SessionState::default());
    let id = open(&state, dir.path(), None);
    let before = state.snapshot(&id).unwrap();
    let fork = state.branch(None, &id, Some("entry-1")).unwrap();
    let branch = fork.branch.unwrap();
    assert_eq!(fork.original.info.session_path, before.info.session_path);
    assert_ne!(branch.info.session_path, before.info.session_path);
    assert_ne!(branch.info.pid, before.info.pid);
    assert_eq!(fork.selected_text.as_deref(), Some("selected question"));
    let again = open(
        &state,
        dir.path(),
        Some(branch.info.session_path.clone().unwrap().into()),
    );
    assert_eq!(again, branch.info.id);
    assert_eq!(state.info().len(), 2);
    let cloned = state.branch(None, &id, None).unwrap();
    assert_eq!(cloned.original.info.session_path, before.info.session_path);
    assert!(cloned.branch.is_some());
    state.shutdown();
}

#[test]
fn cancelled_branch_is_a_noop_and_restore_failure_restarts_original() {
    let dir = tempfile::tempdir().unwrap();
    let state = Arc::new(SessionState::default());
    let id = open(&state, dir.path(), None);
    let before = state.snapshot(&id).unwrap();
    state
        .with(&id, |c| c.request(json!({"type":"cancel_next_branch"})))
        .unwrap();
    let cancelled = state.branch(None, &id, None).unwrap();
    assert!(cancelled.cancelled);
    assert!(cancelled.branch.is_none());
    assert_eq!(state.info().len(), 1);
    state
        .with(&id, |c| c.request(json!({"type":"cancel_next_switch"})))
        .unwrap();
    let recovered = state.branch(None, &id, None).unwrap();
    assert_eq!(
        recovered.original.info.session_path,
        before.info.session_path
    );
    assert_eq!(
        recovered.original.info.generation,
        before.info.generation + 1
    );
    assert_ne!(recovered.original.info.pid, before.info.pid);
    state.shutdown();
}

#[test]
fn concurrent_duplicate_open_has_one_process_and_close_is_idempotent() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("source.jsonl");
    std::fs::write(&path, "{}").unwrap();
    let state = Arc::new(SessionState::default());
    let ids = std::thread::scope(|scope| {
        let workers: Vec<_> = (0..4)
            .map(|_| {
                let state = &state;
                let path = &path;
                let dir = dir.path();
                scope.spawn(move || open(state, dir, Some(path.clone())))
            })
            .collect();
        workers
            .into_iter()
            .map(|w| w.join().unwrap())
            .collect::<Vec<_>>()
    });
    assert!(ids.iter().all(|id| id == &ids[0]));
    assert_eq!(state.info().len(), 1);
    state.close(&ids[0]).unwrap();
    state.close(&ids[0]).unwrap();
}

#[test]
fn failed_handshake_leaves_no_registry_entry() {
    let dir = tempfile::tempdir().unwrap();
    let state = Arc::new(SessionState::default());
    let failing = dir.path().join("fail.cjs");
    std::fs::write(&failing, "process.exit(4);").unwrap();
    assert!(
        state
            .open_no_app(dir.path().into(), None, Some(failing))
            .is_err()
    );
    assert!(state.info().is_empty());
}

#[test]
fn an_error_after_pi_changed_session_restores_original_identity() {
    let dir = tempfile::tempdir().unwrap();
    let state = Arc::new(SessionState::default());
    let id = open(&state, dir.path(), None);
    let before = state.snapshot(&id).unwrap();
    state
        .with(&id, |c| c.request(json!({"type":"fail_next_branch"})))
        .unwrap();
    assert!(state.branch(None, &id, None).is_err());
    let after = state.snapshot(&id).unwrap();
    assert_eq!(after.info.session_path, before.info.session_path);
    assert_eq!(after.info.generation, before.info.generation + 1);
    assert_eq!(state.info().len(), 1);
    state.shutdown();
}
