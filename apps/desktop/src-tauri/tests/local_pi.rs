//! Opt-in local protocol validation; never sends a prompt or calls a model.
use pi_workbench_lib::session::SessionState;
use serde_json::json;
use std::path::PathBuf;
use std::sync::Arc;

#[test]
#[ignore = "requires PI_LOCAL_TEST_EXECUTABLE and an isolated PI_CODING_AGENT_DIR"]
fn installed_pi_restores_clones_and_forks_without_model_requests() {
    let executable = PathBuf::from(
        std::env::var_os("PI_LOCAL_TEST_EXECUTABLE").expect("set explicit installed Pi CLI"),
    );
    let agent = PathBuf::from(
        std::env::var_os("PI_CODING_AGENT_DIR").expect("set isolated agent directory"),
    );
    assert!(
        agent.join("allow-local-test").is_file(),
        "Refusing to use an unmarked agent directory"
    );
    let project = agent.join("project");
    std::fs::create_dir_all(&project).unwrap();
    let source = agent.join("source.jsonl");
    let now = "2026-11-16T00:00:00.000Z";
    let records = [
        json!({"type":"session","version":3,"id":"a350f8a7-f390-40be-b881-6373203ecc28","cwd":project,"timestamp":now}),
        json!({"type":"message","id":"user-first","parentId":null,"timestamp":now,"message":{"role":"user","content":[{"type":"text","text":"offline fixture first question"}],"timestamp":0}}),
        json!({"type":"message","id":"user-second","parentId":"user-first","timestamp":now,"message":{"role":"user","content":[{"type":"text","text":"offline fixture second question"}],"timestamp":0}}),
    ];
    std::fs::write(
        &source,
        records.iter().map(|r| format!("{r}\n")).collect::<String>(),
    )
    .unwrap();
    let state = Arc::new(SessionState::default());
    let id = state.open_no_app(project, None, Some(executable)).unwrap();
    let original = state.replace(None, &id, &source, false).unwrap();
    assert_eq!(original.messages.len(), 2);
    let clone = state.branch(None, &id, None).unwrap();
    assert_eq!(clone.original.info.session_path, original.info.session_path);
    assert_eq!(clone.branch.as_ref().unwrap().messages.len(), 2);
    let fork = state.branch(None, &id, Some("user-second")).unwrap();
    assert_eq!(fork.branch.as_ref().unwrap().messages.len(), 1);
    assert_eq!(
        fork.selected_text.as_deref(),
        Some("offline fixture second question")
    );
    let first = state.branch(None, &id, Some("user-first")).unwrap();
    let branch = first.branch.unwrap();
    assert!(branch.messages.is_empty());
    assert!(PathBuf::from(branch.info.session_path.unwrap()).is_file());
    assert_eq!(state.snapshot(&id).unwrap().messages.len(), 2);
    state.shutdown();
}
