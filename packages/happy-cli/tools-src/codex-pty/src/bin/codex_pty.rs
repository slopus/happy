use anyhow::{anyhow, Context, Result};
use codex_controller::transcript::TranscriptPrinter;
use crossterm::terminal;
use portable_pty::{native_pty_system, Child, CommandBuilder, PtySize};
use serde::Deserialize;
use serde_json::json;
use std::io::{self, IsTerminal, Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;
use tokio::task;

const DEFAULT_PTY_COLS: u16 = 120;
const DEFAULT_PTY_ROWS: u16 = 40;
const VT_SCROLLBACK: usize = 2000;

#[derive(Debug, Clone)]
struct Args {
    pty_cols: u16,
    pty_rows: u16,
}

impl Args {
    fn from_env() -> Result<Self> {
        let mut pty_cols: Option<u16> = None;
        let mut pty_rows: Option<u16> = None;

        let mut it = std::env::args().skip(1);
        while let Some(arg) = it.next() {
            match arg.as_str() {
                "--pty-cols" => {
                    let v = it
                        .next()
                        .ok_or_else(|| anyhow!("--pty-cols requires a value"))?;
                    let n: u16 = v.parse().with_context(|| format!("parse --pty-cols {v}"))?;
                    pty_cols = Some(n);
                }
                "--pty-rows" => {
                    let v = it
                        .next()
                        .ok_or_else(|| anyhow!("--pty-rows requires a value"))?;
                    let n: u16 = v.parse().with_context(|| format!("parse --pty-rows {v}"))?;
                    pty_rows = Some(n);
                }
                "--help" | "-h" => {
                    println!(
                        "codex-pty\n\nFlags:\n  --pty-cols <u16>  (default: 120)\n  --pty-rows <u16>  (default: 40)\n"
                    );
                    std::process::exit(0);
                }
                other if other.starts_with('-') => {
                    return Err(anyhow!("unknown flag: {other}"));
                }
                _ => {}
            }
        }

        Ok(Self {
            pty_cols: pty_cols.unwrap_or(DEFAULT_PTY_COLS),
            pty_rows: pty_rows.unwrap_or(DEFAULT_PTY_ROWS),
        })
    }
}

struct RawModeGuard;

impl RawModeGuard {
    fn enable_if(interactive: bool) -> Result<Option<Self>> {
        if !interactive {
            return Ok(None);
        }
        terminal::enable_raw_mode().context("enable_raw_mode")?;
        Ok(Some(Self))
    }
}

impl Drop for RawModeGuard {
    fn drop(&mut self) {
        let _ = terminal::disable_raw_mode();
    }
}

fn spawn_codex_pty(
    cols: u16,
    rows: u16,
) -> Result<(
    Box<dyn Read + Send>,
    Box<dyn Write + Send>,
    Box<dyn Child + Send + Sync>,
)> {
    let pty_system = native_pty_system();

    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .context("openpty")?;

    let mut c = CommandBuilder::new("codex");

    // Codex exits early when TERM is missing (common when started via nohup/daemon).
    if std::env::var_os("TERM").is_none() {
        c.env("TERM", "xterm-256color");
    }
    if std::env::var_os("COLORTERM").is_none() {
        c.env("COLORTERM", "truecolor");
    }

    c.arg("--no-alt-screen");

    let child = pair.slave.spawn_command(c).context("spawn codex")?;

    let reader = pair
        .master
        .try_clone_reader()
        .context("pty try_clone_reader")?;
    let writer = pair.master.take_writer().context("pty take_writer")?;

    Ok((reader, writer, child))
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum InMsg {
    #[serde(rename = "input")]
    Input { text: String },
    #[serde(rename = "raw")]
    Raw { bytes: Vec<u8> },


    #[serde(rename = "shutdown")]
    Shutdown {},
}

async fn write_user_turn_to_pty(pty_writer: Arc<Mutex<Box<dyn Write + Send>>>, text: String) {
    if text.is_empty() {
        return;
    }

    let bytes = text.into_bytes();
    let enter = vec![b'\r'];

    let _ = task::spawn_blocking(move || {
        {
            let mut w = pty_writer.lock().unwrap();
            let _ = w.write_all(&bytes);
            let _ = w.flush();
        }

        // Keep Enter separate; Codex can treat burst input as paste.
        thread::sleep(Duration::from_millis(20));

        let mut w = pty_writer.lock().unwrap();
        let _ = w.write_all(&enter);
        let _ = w.flush();
    })
    .await;
}
async fn write_raw_to_pty(pty_writer: Arc<Mutex<Box<dyn Write + Send>>>, bytes: Vec<u8>) {
    if bytes.is_empty() {
        return;
    }

    let _ = task::spawn_blocking(move || {
        let mut w = pty_writer.lock().unwrap();
        let _ = w.write_all(&bytes);
        let _ = w.flush();
    })
    .await;
}


fn spawn_transcript_thread(
    mut pty_reader: Box<dyn Read + Send>,
    pty_rows: u16,
    pty_cols: u16,
    tx: mpsc::UnboundedSender<String>,
) {
    thread::spawn(move || {
        let mut vt = vt100::Parser::new(pty_rows, pty_cols, VT_SCROLLBACK);
        let mut last_screen = String::new();
        let mut transcript = TranscriptPrinter::new();

        let mut buf = [0u8; 8192];
        loop {
            let n = match pty_reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => n,
                Err(_) => break,
            };

            vt.process(&buf[..n]);
            let screen = vt.screen().contents();
            if screen != last_screen {
                last_screen.clone_from(&screen);

                for mut block in transcript.on_screen(&screen) {
                    if !block.ends_with('\n') {
                        block.push('\n');
                    }
                    let _ = tx.send(block);
                }
            }
        }
    });
}

fn run_interactive(args: Args) -> Result<()> {
    let _raw_mode = RawModeGuard::enable_if(true)?;

    let (mut pty_reader, pty_writer, mut codex_child) =
        spawn_codex_pty(args.pty_cols, args.pty_rows)?;

    let pty_writer: Arc<Mutex<Box<dyn Write + Send>>> = Arc::new(Mutex::new(pty_writer));

    // Forward local stdin to the Codex PTY so this wrapper behaves like the normal Codex TUI.
    {
        let pty_writer = pty_writer.clone();
        thread::spawn(move || {
            let mut stdin = io::stdin();
            let mut buf = [0u8; 8192];
            loop {
                let n = match stdin.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => n,
                    Err(_) => break,
                };
                let mut w = pty_writer.lock().unwrap();
                let _ = w.write_all(&buf[..n]);
                let _ = w.flush();
            }
        });
    }

    // Mirror PTY output to the local terminal.
    let mut stdout = io::stdout().lock();
    let mut buf = [0u8; 8192];
    loop {
        let n = match pty_reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(_) => break,
        };
        let _ = stdout.write_all(&buf[..n]);
        let _ = stdout.flush();
    }

    let _ = codex_child.wait();
    Ok(())
}

async fn run_jsonl(args: Args) -> Result<()> {
    let (pty_reader, pty_writer, mut codex_child) = spawn_codex_pty(args.pty_cols, args.pty_rows)?;
    let codex_killer = codex_child.clone_killer();

    let pty_writer: Arc<Mutex<Box<dyn Write + Send>>> = Arc::new(Mutex::new(pty_writer));

    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    spawn_transcript_thread(pty_reader, args.pty_rows, args.pty_cols, tx);

    let input_task = {
        let pty_writer = pty_writer.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(tokio::io::stdin()).lines();
            loop {
                let line = match lines.next_line().await {
                    Ok(Some(line)) => line,
                    Ok(None) => break,
                    Err(_) => break,
                };

                let msg: InMsg = match serde_json::from_str(&line) {
                    Ok(v) => v,
                    Err(_) => continue,
                };

                match msg {
                    InMsg::Input { text } => {
                        write_user_turn_to_pty(pty_writer.clone(), text).await;
                    }
                    InMsg::Raw { bytes } => {
                        write_raw_to_pty(pty_writer.clone(), bytes).await;
                    }
                    InMsg::Shutdown {} => break,
                }
            }
        })
    };

    let output_task = tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(chunk) = rx.recv().await {
            let msg = json!({"type": "transcript", "text": chunk});
            let line = match serde_json::to_string(&msg) {
                Ok(s) => s,
                Err(_) => continue,
            };

            if stdout.write_all(line.as_bytes()).await.is_err() {
                break;
            }
            if stdout.write_all(b"\n").await.is_err() {
                break;
            }
            if stdout.flush().await.is_err() {
                break;
            }
        }
    });

    let wait_child = task::spawn_blocking(move || codex_child.wait());

    tokio::select! {
        _ = wait_child => {}
        _ = input_task => {
            let _ = task::spawn_blocking(move || {
                let mut killer = codex_killer;
                let _ = killer.kill();
            }).await;
        }
        _ = output_task => {
            let _ = task::spawn_blocking(move || {
                let mut killer = codex_killer;
                let _ = killer.kill();
            }).await;
        }
    }

    Ok(())
}

#[tokio::main(flavor = "multi_thread")]
async fn main() -> Result<()> {
    let args = Args::from_env()?;

    let interactive_tty = io::stdin().is_terminal() && io::stdout().is_terminal();
    if interactive_tty {
        return run_interactive(args);
    }

    run_jsonl(args).await
}
