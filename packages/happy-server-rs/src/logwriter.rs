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
/// The last slots of the queue only take warnings and errors, so a flood of
/// info lines cannot crowd them out.
const RESERVED: u64 = 1024;

/// Lines dropped since startup (`log_lines_dropped_total` on /metrics).
static DROPPED_TOTAL: AtomicU64 = AtomicU64::new(0);

pub fn dropped_total() -> u64 {
    DROPPED_TOTAL.load(Ordering::Relaxed)
}

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
    spawn(Box::new(std::io::stdout()))
}

fn spawn(sink: Box<dyn Write + Send>) -> Stdout {
    let (tx, rx) = sync_channel::<Vec<u8>>(CAPACITY);
    let state = Arc::new(State { queued: AtomicU64::new(0), written: AtomicU64::new(0), dropped: AtomicU64::new(0), out: Mutex::new(()) });
    let s = state.clone();
    std::thread::Builder::new().name("log-writer".into()).spawn(move || write_loop(rx, s, sink)).expect("log writer thread");
    Stdout { tx, state }
}

fn write_loop(rx: Receiver<Vec<u8>>, state: Arc<State>, mut out: Box<dyn Write + Send>) {
    while let Ok(first) = rx.recv() {
        let _g = state.out.lock();
        let mut n = 1;
        let _ = out.write_all(&first);
        while let Ok(line) = rx.try_recv() {
            let _ = out.write_all(&line);
            n += 1;
        }
        // The queue has drained: say how much was lost meanwhile.
        let dropped = state.dropped.swap(0, Ordering::Relaxed);
        if dropped > 0 {
            let _ = writeln!(out, "log-writer: dropped {} log lines (stdout too slow)", dropped);
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
    priority: bool,
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
        let state = &self.out.state;
        let pending = state.queued.load(Ordering::Acquire).saturating_sub(state.written.load(Ordering::Acquire));
        let sent = (self.priority || pending < CAPACITY as u64 - RESERVED)
            && match self.out.tx.try_send(std::mem::take(&mut self.buf)) {
                Ok(()) => true,
                Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => false,
            };
        if sent {
            state.queued.fetch_add(1, Ordering::Release);
        } else {
            state.dropped.fetch_add(1, Ordering::Relaxed);
            DROPPED_TOTAL.fetch_add(1, Ordering::Relaxed);
        }
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for Stdout {
    type Writer = Line;
    fn make_writer(&'a self) -> Line {
        Line { buf: Vec::with_capacity(256), out: self.clone(), priority: false }
    }
    fn make_writer_for(&'a self, meta: &tracing::Metadata<'_>) -> Line {
        Line { buf: Vec::with_capacity(256), out: self.clone(), priority: *meta.level() <= tracing::Level::WARN }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tracing::callsite::Callsite;
    use tracing_subscriber::fmt::MakeWriter;

    /// A sink that blocks until released, then records what it got.
    struct Gate(Arc<(Mutex<bool>, std::sync::Condvar)>, Arc<Mutex<Vec<u8>>>);
    impl Write for Gate {
        fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
            let (open, cv) = &*self.0;
            let mut g = open.lock().unwrap();
            while !*g {
                g = cv.wait(g).unwrap();
            }
            self.1.lock().unwrap().extend_from_slice(b);
            Ok(b.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn line(out: &Stdout, level: tracing::Level, text: &str) {
        let meta = match level {
            tracing::Level::ERROR => tracing::callsite! { name: "e", kind: tracing::metadata::Kind::EVENT, level: tracing::Level::ERROR, fields: [] }.metadata(),
            _ => tracing::callsite! { name: "i", kind: tracing::metadata::Kind::EVENT, level: tracing::Level::INFO, fields: [] }.metadata(),
        };
        let mut w = out.make_writer_for(meta);
        w.write_all(text.as_bytes()).unwrap();
    }

    #[test]
    fn drops_when_full_but_keeps_errors() {
        let gate = Arc::new((Mutex::new(false), std::sync::Condvar::new()));
        let got = Arc::new(Mutex::new(Vec::new()));
        let out = spawn(Box::new(Gate(gate.clone(), got.clone())));
        let before = dropped_total();
        // The first line is taken by the writer, which then blocks in the sink.
        line(&out, tracing::Level::INFO, "first\n");
        std::thread::sleep(Duration::from_millis(50));
        for _ in 0..CAPACITY {
            line(&out, tracing::Level::INFO, "i\n");
        }
        for _ in 0..10 {
            line(&out, tracing::Level::ERROR, "E\n");
        }
        let dropped = dropped_total() - before;
        // The line stuck in the sink still counts as pending.
        assert_eq!(dropped, RESERVED + 1, "info lines beyond the unreserved slots are dropped");
        *gate.0.lock().unwrap() = true;
        gate.1.notify_all();
        out.drain(Duration::from_secs(5));
        std::thread::sleep(Duration::from_millis(50));
        let text = String::from_utf8(got.lock().unwrap().clone()).unwrap();
        assert_eq!(text.matches("E\n").count(), 10, "errors use the reserved slots");
        assert!(text.ends_with(&format!("dropped {} log lines (stdout too slow)\n", RESERVED + 1)), "{}", &text[text.len() - 80..]);
    }
}
