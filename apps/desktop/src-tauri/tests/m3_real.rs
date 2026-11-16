//! Verifies the M3 code-workbench modules against a real repository.
//!
//! `git.rs` and `files.rs` have no Tauri dependency, so they are tested
//! directly. The git tests use this repository, which is a real work tree.

use std::path::Path;
use std::process::Command;

use pi_workbench_lib::files;
use pi_workbench_lib::git;

/// The workspace root, three levels up from `src-tauri`.
fn project_root() -> &'static Path {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .expect("src-tauri should sit three levels below the workspace")
}

/// A throwaway git repository with one commit and one dirty file.
///
/// The project itself is not under version control, so the git tests build a
/// real repository instead: that exercises the parser against genuine output
/// rather than a hand-written fixture.
fn scratch_repo(name: &str) -> std::path::PathBuf {
    let dir = Path::new(&std::env::var("LOCALAPPDATA").unwrap())
        .join("pi-workbench-test")
        .join(name);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("create scratch repo");

    let run = |args: &[&str]| {
        let output = Command::new("git")
            .arg("-C")
            .arg(&dir)
            .args(args)
            .output()
            .expect("run git");
        assert!(
            output.status.success(),
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr)
        );
    };

    run(&["init", "--quiet"]);
    run(&["config", "user.email", "test@example.invalid"]);
    run(&["config", "user.name", "Test"]);
    run(&["config", "commit.gpgsign", "false"]);

    std::fs::write(dir.join("README.md"), "# scratch\n").unwrap();
    run(&["add", "README.md"]);
    run(&["commit", "--quiet", "-m", "initial"]);

    // One modification and one untracked file.
    std::fs::write(dir.join("README.md"), "# scratch\n\nchanged\n").unwrap();
    std::fs::write(dir.join("notes.txt"), "hello\n").unwrap();
    dir
}

/// Status of a real repository reports its branch and its changes.
#[test]
fn git_reports_a_real_repository() {
    let repo = scratch_repo("git-status");
    let status = git::status(&repo);

    assert!(status.is_repo, "the scratch repo should be a work tree");
    assert!(status.error.is_none(), "unexpected error: {:?}", status.error);
    assert!(status.branch.is_some(), "a branch should be reported");

    let paths: Vec<&str> = status.files.iter().map(|file| file.path.as_str()).collect();
    assert!(paths.contains(&"README.md"), "expected README.md, got {paths:?}");
    assert!(paths.contains(&"notes.txt"), "expected notes.txt, got {paths:?}");

    let readme = status
        .files
        .iter()
        .find(|file| file.path == "README.md")
        .expect("README.md");
    // Unstaged modification: X is `.`, Y is `M`.
    assert_eq!(readme.status, ".");
    assert_eq!(readme.sub_status, Some('M'));

    let notes = status
        .files
        .iter()
        .find(|file| file.path == "notes.txt")
        .expect("notes.txt");
    assert_eq!(notes.status, "?");
    let _ = std::fs::remove_dir_all(&repo);
}

/// A diff of the dirty file contains the expected hunks.
#[test]
fn git_diff_is_valid_output() {
    let repo = scratch_repo("git-diff");
    let diff = git::diff(&repo, Some("README.md"), false).expect("diff should run");

    assert!(diff.contains("diff --git"), "expected a diff header: {diff}");
    assert!(diff.contains("+changed"), "expected the new line: {diff}");
    // No color escapes should leak into the text.
    assert!(!diff.contains('\u{1b}'), "diff should be plain text");

    let _ = std::fs::remove_dir_all(&repo);
}

/// A directory that is not a repository reports that cleanly.
#[test]
fn git_handles_a_non_repo() {
    let status = git::status(Path::new("C:\\Windows\\System32"));
    assert!(!status.is_repo);
    assert!(status.error.is_some());
}

/// The file tree lists this repository's source files.
#[test]
fn file_tree_lists_the_project() {
    let root = project_root();
    let nodes = files::list_dir(root, None, 2).expect("list the project");

    let names: Vec<&str> = nodes.iter().map(|node| node.name.as_str()).collect();
    assert!(
        names.contains(&"Cargo.toml"),
        "expected Cargo.toml, got {names:?}"
    );
    assert!(names.contains(&"crates"), "expected crates/, got {names:?}");
    assert!(names.contains(&"apps"), "expected apps/, got {names:?}");
    // Generated and VCS directories must never appear.
    assert!(!names.contains(&"target"), "target/ must be skipped");
    assert!(!names.contains(&".git"), ".git must be skipped");
    assert!(!names.contains(&"node_modules"), "node_modules must be skipped");

    // Directories sort before files.
    let first_file = nodes.iter().position(|node| !node.is_dir);
    let last_dir = nodes.iter().rposition(|node| node.is_dir);
    if let (Some(first_file), Some(last_dir)) = (first_file, last_dir) {
        assert!(last_dir < first_file, "directories must sort before files");
    }
}

/// Reading the protocol crate's own source returns its module list.
#[test]
fn read_text_reads_a_real_file() {
    let path = project_root().join("crates/pi-rpc/src/lib.rs");
    let file = files::read_text(&path, 64 * 1024).expect("read lib.rs");
    assert!(!file.truncated, "lib.rs should fit in the budget");
    assert!(
        file.text.contains("pub mod client"),
        "lib.rs should declare modules: {}",
        file.text.chars().take(80).collect::<String>()
    );
    assert_eq!(
        files::language_of(&path),
        "rust",
        "a .rs file should be labeled rust"
    );
}
