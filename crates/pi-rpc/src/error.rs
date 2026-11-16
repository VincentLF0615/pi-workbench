use std::time::Duration;

/// Errors surfaced by the pi RPC client.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("could not find the pi executable: {0}")]
    NotFound(String),

    #[error("failed to start pi: {0}")]
    Spawn(String),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("invalid JSON from pi: {0}")]
    Json(#[from] serde_json::Error),

    #[error("pi rejected `{command}`: {message}")]
    Rpc { command: String, message: String },

    #[error("timed out after {0:?} waiting for pi")]
    Timeout(Duration),

    #[error("pi exited unexpectedly (code {0:?})")]
    Exited(Option<i32>),

    #[error("the pi connection is closed")]
    Closed,

    #[error("protocol error: {0}")]
    Protocol(String),
}

pub type Result<T> = std::result::Result<T, Error>;
