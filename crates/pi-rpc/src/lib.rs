//! Client for the pi coding agent's RPC mode.
//!
//! pi exposes a language independent control channel: a long lived child
//! process that reads JSON commands from stdin and writes JSON responses,
//! session events and extension UI requests to stdout. This crate wraps that
//! protocol: process discovery and spawning, JSONL framing, request/response
//! correlation, a typed event stream, and orderly shutdown.
//!
//! ```no_run
//! let mut options = pi_rpc::SpawnOptions::new(".");
//! options.no_session = true;
//! let client = pi_rpc::PiClient::spawn(options)?;
//! let state = client.get_state()?;
//! println!("connected: {state}");
//! client.prompt("Hello")?;
//! client.close()?;
//! # Ok::<(), pi_rpc::Error>(())
//! ```
//!
//! The client uses blocking IO on background threads so it can be driven from
//! any UI event loop without an async runtime dependency.
//!
//! Protocol references (pi 1.5.x): `docs/rpc.md`, `docs/rpc-commands.md`,
//! `docs/json.md`, `docs/rpc-extension-ui.md` inside
//! `@earendil-works/pi-coding-agent`.

#![deny(unsafe_code)]

pub mod client;
pub mod discover;
pub mod error;
pub mod events;
pub mod framer;
pub mod images;
pub mod pump;
pub mod ui;
pub mod wire;

pub use client::{ClientEvent, PiClient, SpawnOptions, DEFAULT_REQUEST_TIMEOUT, SHUTDOWN_GRACE};
pub use error::{Error, Result};
pub use events::PiEvent;
pub use framer::{Framer, DEFAULT_MAX_LINE};
pub use pump::{batch_payload, event_payload, run_pump, BATCH_MAX, BATCH_WINDOW};
pub use ui::{UiReply, UiRequest};

pub use images::{validate_images, ImageContent};
