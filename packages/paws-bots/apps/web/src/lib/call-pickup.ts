/** Ringback while the call connects: one tone, then a pause, like a phone line. */
const RINGBACK_HZ = 425;
const TONE_MS = 1_000;
const PAUSE_MS = 4_000;
const TONE_GAIN = 0.08;
/** Even an instant pickup rings once, so the call reads as a call and not a glitch. */
const MIN_RING_MS = 2_000;

/**
 * Rings until the call can talk: at least one tone, and until the browser has
 * granted the microphone, so its permission prompt shows during the ringing
 * instead of interrupting the first turn. A refused or missing microphone still
 * picks up; listening reports the error on the card.
 */
export async function pickUp(signal: AbortSignal, options: { ring?: boolean } = {}): Promise<void> {
  if (signal.aborted) return;
  // An incoming call the user just answered has nothing to ring for: only the microphone.
  if (options.ring === false) {
    await microphoneReady();
    return;
  }
  const tone = startRingback();
  signal.addEventListener("abort", tone.stop, { once: true });
  if (signal.aborted) tone.stop();
  try {
    await Promise.all([delay(MIN_RING_MS, signal), microphoneReady()]);
  } finally {
    signal.removeEventListener("abort", tone.stop);
    tone.stop();
  }
}

async function microphoneReady(): Promise<void> {
  const media = globalThis.navigator?.mediaDevices;
  if (!media?.getUserMedia) return;
  try {
    const stream = await media.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();
  } catch {
    // Listening asks again and surfaces the failure.
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function startRingback(): { stop: () => void } {
  const Context =
    globalThis.AudioContext ??
    (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Context) return { stop: () => undefined };
  let context: AudioContext;
  try {
    context = new Context();
  } catch {
    return { stop: () => undefined };
  }
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.frequency.value = RINGBACK_HZ;
  gain.gain.value = 0;
  oscillator.connect(gain);
  gain.connect(context.destination);
  const period = (TONE_MS + PAUSE_MS) / 1000;
  const start = context.currentTime + 0.05;
  // Scheduled ahead on the audio clock; a ring longer than this falls silent, not stuck.
  for (let index = 0; index < 12; index += 1) {
    gain.gain.setValueAtTime(TONE_GAIN, start + index * period);
    gain.gain.setValueAtTime(0, start + index * period + TONE_MS / 1000);
  }
  oscillator.start();
  let stopped = false;
  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      try {
        oscillator.stop();
      } catch {
        // Already stopped.
      }
      void context.close().catch(() => undefined);
    },
  };
}
