//! Git status and diff, read with `--porcelain=v2` so the output is stable to
//! parse and does not depend on the user's git config (no pager, no color).

use std::path::Path;
use std::process::Command;

use serde::Serialize;

/// One entry from `git status`.
#[derive(Debug, Clone, Serialize)]
pub struct GitFile {
    pub path: String,
    /// `M` modified, `A` added, `D` deleted, `R` renamed, `?` untracked, ...
    pub status: String,
    /// Second column of the XY status, when git reports one.
    pub sub_status: Option<char>,
    /// Original path for renames.
    pub old_path: Option<String>,
}

/// A project's git summary.
#[derive(Debug, Clone, Serialize)]
pub struct GitStatus {
    /// Whether the directory is inside a git work tree at all.
    pub is_repo: bool,
    pub branch: Option<String>,
    pub files: Vec<GitFile>,
    pub error: Option<String>,
}

/// Read the status of one project directory.
pub fn status(project_dir: &Path) -> GitStatus {
    let mut command = git_command(project_dir);
    command.args(["status", "--porcelain=v2", "--branch", "-z"]);

    let output = match command.output() {
        Ok(output) => output,
        Err(error) => {
            return GitStatus {
                is_repo: false,
                branch: None,
                files: Vec::new(),
                error: Some(format!("could not run git: {error}")),
            };
        }
    };

    if !output.status.success() {
        let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
        // "not a git repository" is a normal state, not an error worth showing.
        let is_repo = !message.contains("not a git repository");
        return GitStatus {
            is_repo,
            branch: None,
            files: Vec::new(),
            error: (!is_repo).then_some(message),
        };
    }

    parse_porcelain_v2(&String::from_utf8_lossy(&output.stdout))
}

/// Parse `git status --porcelain=v2 --branch -z` output.
///
/// With `-z`, records are NUL-separated and paths are not quoted. The branch
/// header is a run of `# ...` records at the start; an ordinary entry is one
/// record; a rename is two (the entry, then the original path).
pub fn parse_porcelain_v2(text: &str) -> GitStatus {
    let mut branch = None;
    let mut files = Vec::new();

    let records: Vec<&str> = text.split('\0').collect();
    let mut index = 0;
    while index < records.len() {
        let record = records[index];
        index += 1;

        // Branch header lines come first: `# branch.head <name>`.
        if let Some(rest) = record.strip_prefix("# ") {
            if let Some(name) = rest.strip_prefix("branch.head ") {
                branch = Some(name.trim().to_string());
            }
            continue;
        }
        if record.is_empty() {
            continue;
        }

        // The path is the last field and may contain spaces, so split only
        // the fixed-width prefix and keep the remainder as the path. The
        // prefix is: type, XY, sub, three mode columns, and two object ids.
        // A rename (`2`) adds one score field, hence the different counts.
        let kind = record.split(' ').next().unwrap_or("");
        let splits = if kind == "2" { 10 } else { 9 };
        let fields: Vec<&str> = record.splitn(splits, ' ').collect();
        // Everything after the fixed-width prefix is the path.
        let path = fields.last().copied().unwrap_or("");
        // XY is the second field; its two characters are the staged and
        // worktree states, and `.` means "unchanged in that column".
        let xy = fields.get(1).copied().unwrap_or("??");
        let status = xy.chars().next().unwrap_or('?');
        let sub_status = xy.chars().nth(1);

        match kind {
            // `1 <XY> <sub> <mH> <mI> <mW> <hH> <path>`
            "1" => {
                files.push(GitFile {
                    path: path.to_string(),
                    status: status.to_string(),
                    sub_status,
                    old_path: None,
                });
            }
            // `2 <XY> <sub> <mH> <mI> <mW> <hH> <X><score> <path>`, with the
            // original path in the following record.
            "2" => {
                let old_path = records.get(index).copied();
                if old_path.is_some() {
                    index += 1;
                }
                files.push(GitFile {
                    path: path.to_string(),
                    status: status.to_string(),
                    sub_status,
                    old_path: old_path.map(str::to_string),
                });
            }
            // Unmerged: `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>`
            "u" => {
                files.push(GitFile {
                    path: path.to_string(),
                    status: "U".to_string(),
                    sub_status: None,
                    old_path: None,
                });
            }
            // Untracked: `? <path>`
            "?" => {
                files.push(GitFile {
                    path: path.to_string(),
                    status: "?".to_string(),
                    sub_status: None,
                    old_path: None,
                });
            }
            _ => {}
        }
    }

    GitStatus {
        is_repo: true,
        branch,
        files,
        error: None,
    }
}

/// Diff for one file, or for the whole project when `path` is `None`.
pub fn diff(project_dir: &Path, path: Option<&str>, staged: bool) -> Result<String, String> {
    let mut command = git_command(project_dir);
    command.args(["diff", "--no-color", "--no-ext-diff", "-U3"]);
    if staged {
        command.arg("--cached");
    }
    if let Some(path) = path {
        command.arg("--").arg(path);
    }

    let output = command.output().map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// A git command with output never going through a pager or color settings.
fn git_command(project_dir: &Path) -> Command {
    let mut command = Command::new("git");
    command.arg("-C").arg(project_dir);
    command.arg("--no-pager");
    // GIT_CONFIG_PARAMETERS takes quoted `key=value` pairs; a bare value makes
    // git abort with "bogus format".
    command.env("GIT_CONFIG_PARAMETERS", "'color.ui=false'");
    command.env("GIT_PAGER", "");
    command.stdin(std::process::Stdio::null());
    command.stdout(std::process::Stdio::piped());
    command.stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    command
}

/// Whether a directory is inside a git work tree.
pub fn is_repo(project_dir: &Path) -> bool {
    git_command(project_dir)
        .args(["rev-parse", "--is-inside-work-tree"])
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_branch_and_modified_files() {
        // Each `# ...` header is its own NUL-separated record.
        // An ordinary entry is `1 <XY> <sub> <mH> <mI> <mW> <hH> <path>` with
        // three mode columns and two object ids.
        let text = "# branch.oid abc\0# branch.head main\0# branch.upstream origin/main\0\
                    1 .M N... 100644 100644 100644 af0f69 af0f69 src/lib.rs\0\
                    1 A. N... 100644 100644 100644 af0f69 af0f69 src/new.rs\0";
        let status = parse_porcelain_v2(text);
        assert!(status.is_repo);
        assert_eq!(status.branch.as_deref(), Some("main"));
        assert_eq!(status.files.len(), 2);

        // XY = `.M`: nothing staged (`.`), modified in the worktree (`M`).
        assert_eq!(status.files[0].path, "src/lib.rs");
        assert_eq!(status.files[0].status, ".");
        assert_eq!(status.files[0].sub_status, Some('M'));

        // XY = `A.`: staged as added, worktree clean.
        assert_eq!(status.files[1].path, "src/new.rs");
        assert_eq!(status.files[1].status, "A");
        assert_eq!(status.files[1].sub_status, Some('.'));
    }

    #[test]
    fn parses_untracked_and_renamed_entries() {
        // A rename is two records: the entry, then the original path.
        let text = "? notes.txt\0\
                    2 R. N... 100644 100644 100644 af0f69 af0f69 R100 new/name.rs\0old/name.rs\0";
        let status = parse_porcelain_v2(text);
        assert_eq!(status.files.len(), 2);

        let untracked = &status.files[0];
        assert_eq!(untracked.path, "notes.txt");
        assert_eq!(untracked.status, "?");

        let renamed = &status.files[1];
        assert_eq!(renamed.path, "new/name.rs");
        assert_eq!(renamed.status, "R");
        assert_eq!(renamed.old_path.as_deref(), Some("old/name.rs"));
    }

    #[test]
    fn handles_paths_with_spaces() {
        // A path with spaces must survive the field split intact.
        let text = "1 .M N... 100644 100644 100644 af0f69 af0f69 my docs/a file.rs\0";
        let status = parse_porcelain_v2(text);
        assert_eq!(status.files.len(), 1);
        assert_eq!(status.files[0].path, "my docs/a file.rs");
    }

    #[test]
    fn empty_input_is_an_empty_repo_status() {
        let status = parse_porcelain_v2("");
        assert!(status.is_repo);
        assert!(status.branch.is_none());
        assert!(status.files.is_empty());
    }

    #[test]
    fn a_non_repo_directory_reports_no_repo() {
        let status = status(Path::new("C:\\Windows\\System32"));
        assert!(!status.is_repo);
        assert!(status.error.is_some());
    }
}
