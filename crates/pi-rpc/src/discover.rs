//! Locate the `pi` installation to launch.
//!
//! Discovery order:
//!
//! 1. an explicit path (CLI flag / app setting);
//! 2. `PI_EXECUTABLE`;
//! 3. the managed install at `%USERPROFILE%\.pi\agent\bin\pi-launcher.js`,
//!    launched through `node` so upgrades are picked up automatically;
//! 4. `pi.exe` on `PATH`;
//! 5. `pi.cmd` on `PATH`, run through `cmd /C`;
//! 6. the npm global shim.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use crate::error::{Error, Result};

/// What to execute, and how.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LaunchKind {
    /// `node <launcher.js> ...`: the self-managed install.
    NodeLauncher { node: PathBuf, launcher: PathBuf },
    /// A native executable (`pi.exe`).
    Executable(PathBuf),
    /// A `.cmd` / `.bat` shim, which must run through `cmd /C`.
    CmdScript(PathBuf),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchSpec {
    pub kind: LaunchKind,
    /// Human readable location, for logs and diagnostics.
    pub source: String,
}

impl LaunchSpec {
    /// Program plus fixed leading arguments, before the pi arguments.
    pub fn program(&self) -> (PathBuf, Vec<OsString>) {
        match &self.kind {
            LaunchKind::NodeLauncher { node, launcher } => {
                (node.clone(), vec![launcher.clone().into_os_string()])
            }
            LaunchKind::Executable(path) => (path.clone(), Vec::new()),
            LaunchKind::CmdScript(path) => (
                PathBuf::from("cmd.exe"),
                vec!["/C".into(), path.clone().into_os_string()],
            ),
        }
    }

    pub fn display(&self) -> &str {
        &self.source
    }
}

/// Resolve the pi installation, honoring an explicit path first.
pub fn discover(explicit: Option<&Path>) -> Result<LaunchSpec> {
    if let Some(path) = explicit {
        return spec_from_path(path);
    }
    if let Some(path) = std::env::var_os("PI_EXECUTABLE") {
        return spec_from_path(Path::new(&path));
    }

    if let Some(agent_dir) = agent_dir() {
        let launcher = agent_dir.join("bin").join("pi-launcher.js");
        if launcher.is_file() {
            if let Some(node) = resolve_node() {
                return Ok(LaunchSpec {
                    kind: LaunchKind::NodeLauncher { node, launcher },
                    source: format!("managed install ({})", agent_dir.display()),
                });
            }
        }
    }

    if let Some(path) = which(&["pi.exe"]) {
        return Ok(LaunchSpec {
            kind: LaunchKind::Executable(path.clone()),
            source: format!("PATH ({})", path.display()),
        });
    }
    if let Some(path) = which(&["pi.cmd", "pi.bat"]) {
        return Ok(LaunchSpec {
            kind: LaunchKind::CmdScript(path.clone()),
            source: format!("PATH ({})", path.display()),
        });
    }
    if let Some(appdata) = std::env::var_os("APPDATA") {
        let shim = PathBuf::from(appdata).join("npm").join("pi.cmd");
        if shim.is_file() {
            return Ok(LaunchSpec {
                kind: LaunchKind::CmdScript(shim.clone()),
                source: format!("npm global ({})", shim.display()),
            });
        }
    }

    Err(Error::NotFound(
        "no explicit path, PI_EXECUTABLE, ~/.pi/agent/bin/pi-launcher.js, or pi on PATH".into(),
    ))
}

fn spec_from_path(path: &Path) -> Result<LaunchSpec> {
    if !path.is_file() {
        return Err(Error::NotFound(path.display().to_string()));
    }
    let source = path.display().to_string();
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();

    let kind = match extension.as_str() {
        "js" | "mjs" | "cjs" => {
            let node = resolve_node().ok_or_else(|| {
                Error::NotFound("node.js is required to run a JavaScript pi launcher".into())
            })?;
            LaunchKind::NodeLauncher {
                node,
                launcher: path.to_path_buf(),
            }
        }
        "cmd" | "bat" => LaunchKind::CmdScript(path.to_path_buf()),
        _ => LaunchKind::Executable(path.to_path_buf()),
    };
    Ok(LaunchSpec { kind, source })
}

fn agent_dir() -> Option<PathBuf> {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)?;
    let agent = home.join(".pi").join("agent");
    agent.is_dir().then_some(agent)
}

fn resolve_node() -> Option<PathBuf> {
    if let Some(path) = which(&["node.exe", "node"]) {
        return Some(path);
    }
    let mut candidates = Vec::new();
    if let Some(program_files) = std::env::var_os("ProgramFiles") {
        candidates.push(PathBuf::from(program_files).join("nodejs").join("node.exe"));
    }
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        candidates.push(
            PathBuf::from(local_app_data)
                .join("Programs")
                .join("nodejs")
                .join("node.exe"),
        );
    }
    candidates.into_iter().find(|candidate| candidate.is_file())
}

/// Minimal `which`: search PATH for the first candidate name that exists.
pub fn which(names: &[&str]) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        for name in names {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_missing_path_is_not_found() {
        let err = discover(Some(Path::new("Z:\\definitely\\missing\\pi.exe"))).unwrap_err();
        assert!(matches!(err, Error::NotFound(_)));
    }

    #[test]
    fn managed_install_is_found_on_this_machine() {
        // Only meaningful on a machine with pi installed; skip silently otherwise.
        let Ok(spec) = discover(None) else {
            return;
        };
        let (program, _prefix) = spec.program();
        match &spec.kind {
            LaunchKind::NodeLauncher { node, launcher } => {
                assert!(node.is_file());
                assert!(launcher.is_file());
            }
            LaunchKind::Executable(path) => assert!(path.is_file()),
            LaunchKind::CmdScript(path) => assert!(path.is_file()),
        }
        assert!(program.is_file() || program.as_os_str() == "cmd.exe");
    }
}
