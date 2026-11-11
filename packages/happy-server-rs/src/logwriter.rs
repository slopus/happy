//! Log output from a dedicated thread. A `write(2)` to stdout can stall (a slow
//! pipe, a disk under writeback pressure); on a runtime worker that also stalls
//! whatever task the worker just woke, such as the socket a handler has emitted to.

use std::io::Write;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Lines buffered before new ones are dropped (and counted).
const CAPACITY: usize = 64 * 1024;

#[derive(Clone)]
pub struct Stdout {
    tx: SyncSender<Vec<u8>>,
    state: Arc<State>,
}

struct State {
    queued: AtomicU64,
    written: AtomicU64,
    dropped: AtomicU64,
    /// Serializes `drain` with the writer's batches.
    out: Mutex<()>,
}

pub fn stdout() -> Stdout {
    let (tx, rx) = sync_channel::<Vec<u8>>(CAPACITY);
    let state = Arc::new(State { queued: AtomicU64::new(0), written: AtomicU64::new(0), dropped: AtomicU64::new(0), out: Mutex::new(()) });
    let s = state.clone();
    std::thread::Builder::new().name("log-writer".into()).spawn(move || write_loop(rx, s)).expect("log writer thread");
    Stdout { tx, state }
}

fn write_loop(rx: Receiver<Vec<u8>>, state: Arc<State>) {
    while let Ok(first) = rx.recv() {
        let _g = state.out.lock();
        let mut out = std::io::stdout().lock();
        let mut n = 1;
        let _ = out.write_all(&first);
        while let Ok(line) = rx.try_recv() {
            let _ = out.write_all(&line);
            n += 1;
        }
        let dropped = state.dropped.swap(0, Ordering::Relaxed);
        if dropped > 0 {
            let _ = writeln!(out, "log-writer: {} line(s) dropped (output too slow)", dropped);
        }
        let _ = out.flush();
        state.written.fetch_add(n, Ordering::Release);
    }
}

impl Stdout {
    /// Waits (up to `max`) for queued lines to reach stdout; for process exit.
    pub fn drain(&self, max: Duration) {
        let end = std::time::Instant::now() + max;
        while self.state.written.load(Ordering::Acquire) < self.state.queued.load(Ordering::Acquire) && std::time::Instant::now() < end {
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}

pub struct Line {
    buf: Vec<u8>,
    out: Stdout,
}

impl Write for Line {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        self.buf.extend_from_slice(b);
        Ok(b.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl Drop for Line {
    fn drop(&mut self) {
        if self.buf.is_empty() {
            return;
        }
        match self.out.tx.try_send(std::mem::take(&mut self.buf)) {
            Ok(()) => {
                self.out.state.queued.fetch_add(1, Ordering::Release);
            }
            Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => {
                self.out.state.dropped.fetch_add(1, Ordering::Relaxed);
            }
        }
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for Stdout {
    type Writer = Line;
    fn make_writer(&'a self) -> Line {
        Line { buf: Vec::with_capacity(256), out: self.clone() }
    }
}
