//! Project file tree with a bounded, deterministic walk.
//!
//! The tree is read on demand and cached per request: it powers the sidebar's
//! file panel and the "reveal in tree" jump from a tool card. Heavy and
//! generated directories are skipped so a large repo stays responsive.

use std::path::Path;

use serde::Serialize;

/// Directories never descended into, regardless of the user's ignore rules.
const ALWAYS_SKIP: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".nuxt",
    ".svelte-kit",
    "__pycache__",
    ".venv",
    "venv",
    ".idea",
    ".vscode",
    "AppData",
];

/// Upper bound on entries returned for one directory.
const MAX_ENTRIES_PER_DIR: usize = 2000;
/// Upper bound on total entries in one listing.
const MAX_TOTAL_ENTRIES: usize = 20000;

/// One node of the file tree.
#[derive(Debug, Clone, Serialize)]
pub struct FileNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub children: Option<Vec<FileNode>>,
}

/// List one directory level (or the whole tree when `depth` allows).
pub fn list_dir(root: &Path, relative: Option<&str>, depth: usize) -> Result<Vec<FileNode>, String> {
    let target = match relative {
        Some(relative) if !relative.is_empty() => root.join(relative),
        _ => root.to_path_buf(),
    };
    if !target.is_dir() {
        return Err(format!("not a directory: {}", target.display()));
    }
    let mut budget = MAX_TOTAL_ENTRIES;
    read_dir(&target, depth, &mut budget)
}

fn read_dir(dir: &Path, depth: usize, budget: &mut usize) -> Result<Vec<FileNode>, String> {
    let entries = std::fs::read_dir(dir).map_err(|error| error.to_string())?;
    let mut nodes = Vec::new();

    for entry in entries.flatten() {
        if *budget == 0 || nodes.len() >= MAX_ENTRIES_PER_DIR {
            break;
        }
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        let is_dir = path.is_dir();

        if is_dir && ALWAYS_SKIP.contains(&name.as_str()) {
            continue;
        }

        let children = if is_dir && depth > 1 {
            *budget -= 1;
            Some(read_dir(&path, depth - 1, budget)?)
        } else {
            None
        };

        nodes.push(FileNode {
            name,
            path: path.to_string_lossy().to_string(),
            is_dir,
            children,
        });
        *budget = budget.saturating_sub(1);
    }

    // Directories first, then files, each alphabetical: a stable, scannable order.
    nodes.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.cmp(&b.name)));
    Ok(nodes)
}

/// Read a text file with a size cap so a huge file cannot freeze the UI.
pub fn read_text(path: &Path, max_bytes: usize) -> Result<TextFile, String> {
    const MAX_BYTES: usize = 2 * 1024 * 1024;

    let metadata = std::fs::metadata(path).map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err(format!("not a file: {}", path.display()));
    }
    if metadata.len() as usize > MAX_BYTES {
        return Err(format!(
            "file is too large to preview ({:.1} MB)",
            metadata.len() as f64 / 1024.0 / 1024.0
        ));
    }

    let bytes = std::fs::read(path).map_err(|error| error.to_string())?;
    let truncated = bytes.len() > max_bytes;
    let slice = if truncated { &bytes[..max_bytes] } else { &bytes[..] };
    let text = String::from_utf8_lossy(slice).to_string();

    Ok(TextFile {
        path: path.to_string_lossy().to_string(),
        text,
        truncated,
        total_bytes: bytes.len(),
    })
}

/// A text file's contents, possibly truncated.
#[derive(Debug, Clone, Serialize)]
pub struct TextFile {
    pub path: String,
    pub text: String,
    pub truncated: bool,
    pub total_bytes: usize,
}

/// Guess a language hint from the extension, for the preview's label.
pub fn language_of(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "rs" => "rust",
        "ts" | "tsx" => "typescript",
        "js" | "jsx" | "mjs" | "cjs" => "javascript",
        "py" => "python",
        "toml" => "toml",
        "json" | "jsonl" => "json",
        "md" | "markdown" => "markdown",
        "css" => "css",
        "html" | "htm" => "html",
        "sh" | "bash" | "zsh" => "shell",
        "ps1" => "powershell",
        "cmd" | "bat" => "batch",
        "yml" | "yaml" => "yaml",
        "c" | "h" => "c",
        "cpp" | "cc" | "hpp" => "cpp",
        "go" => "go",
        "java" => "java",
        "sql" => "sql",
        "" => "text",
        _ => "text",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A scratch directory we can write to.
    ///
    /// The DSH workspace carries the Low mandatory-integrity label, which also
    /// applies to `%TEMP%`, so tests use `%LOCALAPPDATA%` instead. Each test
    /// owns its own leaf directory, so parallel runs never collide and no test
    /// removes a directory another one is still using.
    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = Path::new(&std::env::var("LOCALAPPDATA").unwrap())
            .join("pi-workbench-test")
            .join(name);
        cleanup(&dir);
        std::fs::create_dir_all(&dir).expect("create scratch dir");
        dir
    }

    /// Remove one test's leaf directory only.
    fn cleanup(dir: &Path) {
        let _ = std::fs::remove_dir_all(dir);
    }

    fn tree_of(root: &Path) -> Vec<String> {
        fn walk(nodes: &[FileNode], out: &mut Vec<String>) {
            for node in nodes {
                out.push(node.path.clone());
                if let Some(children) = &node.children {
                    walk(children, out);
                }
            }
        }
        let mut out = Vec::new();
        walk(&list_dir(root, None, 3).unwrap(), &mut out);
        out.sort();
        out
    }

    #[test]
    fn walks_a_tree_and_skips_generated_directories() {
        let root = scratch("filetree");
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::create_dir_all(root.join("node_modules")).unwrap();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::write(root.join("Cargo.toml"), "").unwrap();
        std::fs::write(root.join("src").join("lib.rs"), "fn main() {}").unwrap();
        std::fs::write(root.join("node_modules").join("dep.js"), "").unwrap();
        std::fs::write(root.join(".git").join("HEAD"), "").unwrap();

        let paths = tree_of(&root);
        assert!(paths.iter().any(|path| path.ends_with("Cargo.toml")));
        assert!(paths.iter().any(|path| path.ends_with("lib.rs")));
        assert!(!paths.iter().any(|path| path.contains("node_modules")));
        assert!(!paths.iter().any(|path| path.contains(".git")));

        cleanup(&root);
    }

    #[test]
    fn directories_sort_before_files() {
        let root = scratch("sort");
        std::fs::create_dir_all(root.join("zeta")).unwrap();
        std::fs::write(root.join("alpha.txt"), "").unwrap();

        let nodes = list_dir(&root, None, 1).unwrap();
        assert_eq!(nodes.len(), 2);
        assert!(nodes[0].is_dir, "directories must come first");
        assert_eq!(nodes[0].name, "zeta");
        assert_eq!(nodes[1].name, "alpha.txt");

        cleanup(&root);
    }

    #[test]
    fn read_text_truncates_and_reports_the_full_size() {
        let dir = scratch("read-text");
        let path = dir.join("sample.txt");
        std::fs::write(&path, "0123456789").unwrap();

        let full = read_text(&path, 1024).unwrap();
        assert_eq!(full.text, "0123456789");
        assert!(!full.truncated);
        assert_eq!(full.total_bytes, 10);

        let cut = read_text(&path, 4).unwrap();
        assert_eq!(cut.text, "0123");
        assert!(cut.truncated);
        assert_eq!(cut.total_bytes, 10);

        cleanup(&dir);
    }

    #[test]
    fn language_hints_cover_common_extensions() {
        assert_eq!(language_of(Path::new("a.rs")), "rust");
        assert_eq!(language_of(Path::new("a.tsx")), "typescript");
        assert_eq!(language_of(Path::new("a.unknown")), "text");
        assert_eq!(language_of(Path::new("noext")), "text");
    }
}
