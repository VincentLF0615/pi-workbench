//! Command line probe for the pi RPC protocol.
//!
//! ```text
//! pi-probe --cwd E:\project --prompt "Summarize this repo"
//! pi-probe --cwd E:\project --prompt "hi" --no-session --json
//! ```
//!
//! It prints streamed assistant text as it arrives, tool activity, and the
//! final settle reason. Exit code 0 means pi reached `agent_settled` without
//! an error response; 1 means spawn/protocol/exit failure.

use std::io::Write;
use std::path::PathBuf;
use std::sync::mpsc::RecvTimeoutError;
use std::time::{Duration, Instant};

use pi_rpc::{ClientEvent, PiClient, SpawnOptions, UiReply};

#[derive(Debug)]
struct Args {
    cwd: PathBuf,
    prompt: Option<String>,
    session: Option<PathBuf>,
    executable: Option<PathBuf>,
    no_session: bool,
    json: bool,
    timeout: Duration,
    extra: Vec<String>,
}

impl Default for Args {
    fn default() -> Self {
        Self {
            cwd: std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
            prompt: None,
            session: None,
            executable: None,
            no_session: false,
            json: false,
            timeout: Duration::from_secs(600),
            extra: Vec::new(),
        }
    }
}

fn parse_args() -> Result<Args, String> {
    let mut args = Args::default();
    let mut iter = std::env::args().skip(1);
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--cwd" => args.cwd = PathBuf::from(iter.next().ok_or("--cwd needs a value")?),
            "--prompt" | "-p" => {
                args.prompt = Some(iter.next().ok_or("--prompt needs a value")?);
            }
            "--session" => {
                args.session = Some(PathBuf::from(iter.next().ok_or("--session needs a value")?));
            }
            "--executable" => {
                args.executable = Some(PathBuf::from(
                    iter.next().ok_or("--executable needs a value")?,
                ));
            }
            "--no-session" => args.no_session = true,
            "--json" => args.json = true,
            "--timeout" => {
                let seconds: u64 = iter
                    .next()
                    .ok_or("--timeout needs a value")?
                    .parse()
                    .map_err(|_| "--timeout must be seconds")?;
                args.timeout = Duration::from_secs(seconds);
            }
            "--arg" => args.extra.push(iter.next().ok_or("--arg needs a value")?),
            "--help" | "-h" => {
                println!(
                    "usage: pi-probe [--cwd DIR] --prompt TEXT [--no-session] [--session PATH]\n\
                     \x20              [--executable PATH] [--json] [--timeout SECONDS] [--arg VALUE]"
                );
                std::process::exit(0);
            }
            other => return Err(format!("unknown argument: {other}")),
        }
    }
    Ok(args)
}

fn main() {
    let args = match parse_args() {
        Ok(args) => args,
        Err(error) => {
            eprintln!("pi-probe: {error}");
            std::process::exit(2);
        }
    };
    let prompt = args
        .prompt
        .clone()
        .unwrap_or_else(|| "Reply with exactly: OK".to_string());

    let mut options = SpawnOptions::new(&args.cwd);
    options.session = args.session.clone();
    options.executable = args.executable.clone();
    options.no_session = args.no_session;
    options.extra_args = args.extra.clone();

    let started = Instant::now();
    let client = match PiClient::spawn(options) {
        Ok(client) => client,
        Err(error) => {
            eprintln!("pi-probe: failed to start pi: {error}");
            std::process::exit(1);
        }
    };
    eprintln!(
        "pi-probe: started pi (pid {}) from {} in {}",
        client.pid(),
        client.launch_source(),
        args.cwd.display()
    );

    let events = client.subscribe();

    let state = match client.get_state() {
        Ok(state) => state,
        Err(error) => {
            eprintln!("pi-probe: get_state failed: {error}");
            eprintln!(
                "pi-probe: closed={} pid={}",
                client.is_closed(),
                client.pid()
            );
            for line in client.stderr_tail() {
                eprintln!("pi stderr: {line}");
            }
            let _ = client.close();
            std::process::exit(1);
        }
    };
    let model = state
        .get("model")
        .and_then(|model| {
            let provider = model.get("provider").and_then(|value| value.as_str())?;
            let id = model.get("id").and_then(|value| value.as_str())?;
            Some(format!("{provider}/{id}"))
        })
        .unwrap_or_else(|| "<no model>".to_string());
    eprintln!(
        "pi-probe: session {} model {} thinking {}",
        state
            .get("sessionId")
            .and_then(|value| value.as_str())
            .unwrap_or("?"),
        model,
        state
            .get("thinkingLevel")
            .and_then(|value| value.as_str())
            .unwrap_or("?")
    );

    if let Err(error) = client.prompt(prompt.clone()) {
        eprintln!("pi-probe: prompt rejected: {error}");
        let _ = client.close();
        std::process::exit(1);
    }

    let deadline = Instant::now() + args.timeout;
    let mut first_delta: Option<Duration> = None;
    let mut settled = false;
    let mut failure: Option<String> = None;

    loop {
        if Instant::now() >= deadline {
            failure = Some("probe timed out".to_string());
            break;
        }
        let wait = (deadline - Instant::now()).min(Duration::from_millis(250));
        let event = match events.recv_timeout(wait) {
            Ok(event) => event,
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => {
                failure = Some("event stream closed".to_string());
                break;
            }
        };

        match event {
            ClientEvent::Pi(event) => {
                if args.json {
                    println!("{}", serde_json::to_string(&event).unwrap_or_default());
                    continue;
                }
                match &event {
                    pi_rpc::PiEvent::MessageUpdate {
                        assistant_message_event,
                        ..
                    } => {
                        if let Some((delta, _index)) =
                            pi_rpc::events::text_delta(assistant_message_event)
                        {
                            if first_delta.is_none() {
                                first_delta = Some(started.elapsed());
                                eprintln!(
                                    "pi-probe: first text delta after {:?}",
                                    first_delta.unwrap()
                                );
                            }
                            print!("{delta}");
                            let _ = std::io::stdout().flush();
                        }
                    }
                    pi_rpc::PiEvent::ToolExecutionStart {
                        tool_name,
                        args: tool_args,
                        ..
                    } => {
                        println!(
                            "\n[tool] {tool_name} {}",
                            truncate(&tool_args.to_string(), 300)
                        );
                    }
                    pi_rpc::PiEvent::ToolExecutionEnd {
                        tool_name,
                        is_error,
                        duration_ms,
                        ..
                    } => {
                        println!(
                            "[tool done] {tool_name} ok={} {}ms",
                            !is_error,
                            duration_ms.unwrap_or_default()
                        );
                    }
                    pi_rpc::PiEvent::MessageEnd { message } => {
                        if message.get("role").and_then(|role| role.as_str()) == Some("assistant") {
                            println!(
                                "\n[assistant end] stopReason={} tokens={}",
                                message
                                    .get("stopReason")
                                    .and_then(|value| value.as_str())
                                    .unwrap_or("?"),
                                message
                                    .get("usage")
                                    .and_then(|usage| usage.get("totalTokens"))
                                    .and_then(|value| value.as_u64())
                                    .unwrap_or(0)
                            );
                        }
                    }
                    pi_rpc::PiEvent::CompactionStart { reason } => {
                        println!("\n[compaction] start ({reason})");
                    }
                    pi_rpc::PiEvent::CompactionEnd {
                        reason, aborted, ..
                    } => {
                        println!("[compaction] end ({reason}) aborted={aborted}");
                    }
                    pi_rpc::PiEvent::AutoRetryStart {
                        attempt,
                        max_attempts,
                        delay_ms,
                        error_message,
                    } => {
                        println!(
                            "\n[retry] {attempt}/{max_attempts} in {delay_ms}ms: {error_message}"
                        );
                    }
                    pi_rpc::PiEvent::AgentSettled { aborted } => {
                        println!("\n=== agent_settled aborted={aborted}");
                        settled = true;
                        break;
                    }
                    pi_rpc::PiEvent::ExtensionError { error, .. } => {
                        eprintln!("\n[extension error] {error}");
                    }
                    _ => {}
                }
            }
            ClientEvent::Ui(request) => {
                if request.is_dialog() {
                    eprintln!(
                        "\n[ui dialog: {}] {} (auto-cancelled by probe)",
                        request.method,
                        request.summary()
                    );
                    let _ = client.respond_ui(&request.id, &UiReply::Cancelled);
                } else {
                    eprintln!("\n[ui {}] {}", request.method, request.summary());
                }
            }
            ClientEvent::ProtocolError(message) => {
                eprintln!("\n[protocol error] {message}");
            }
            ClientEvent::Exited(code) => {
                failure = Some(format!("pi exited before agent_settled (code {code:?})"));
                break;
            }
        }
    }

    let _ = client.close();
    println!();

    if let Some(error) = failure {
        eprintln!("pi-probe: {error}");
        std::process::exit(1);
    }
    if !settled {
        eprintln!("pi-probe: no agent_settled received");
        std::process::exit(1);
    }
    eprintln!(
        "pi-probe: ok (total {:?}, stderr lines {})",
        started.elapsed(),
        client.stderr_tail().len()
    );
}

fn truncate(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        text.to_string()
    } else {
        let mut out: String = text.chars().take(max).collect();
        out.push('…');
        out
    }
}
