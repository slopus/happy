import type { RakazoDesktopSpeechEvent } from "@rakazo/contracts";
import { desktopBridge } from "./desktop.js";

let sessions = 0;

/**
 * Web Speech's recognizer over the desktop app's system recognizer, so dictation keeps
 * one listening loop. Each `start` is its own session; events from an earlier one are ignored.
 */
export class DesktopSpeechRecognition {
  continuous = true;
  interimResults = true;
  lang = "";
  onresult:
    | ((event: { resultIndex: number; results: SpeechRecognitionResultList }) => void)
    | null = null;
  onerror: ((event: { error?: string }) => void) | null = null;
  onend: (() => void) | null = null;
  private session = 0;
  private unsubscribe: (() => void) | null = null;

  start() {
    const speech = desktopBridge()?.speech;
    if (!speech) throw new Error("System speech recognition is unavailable.");
    if (this.session) throw new Error("Speech recognition has already started.");
    const session = ++sessions;
    this.session = session;
    const handle = (event: RakazoDesktopSpeechEvent) => {
      if (event.session !== session || this.session !== session) return;
      if (event.type === "result") {
        const results = [[{ transcript: event.text }]] as unknown as SpeechRecognitionResultList;
        this.onresult?.({ resultIndex: 0, results });
      } else if (event.type === "error") {
        this.onerror?.({ error: event.error });
      } else {
        this.release();
        this.onend?.();
      }
    };
    this.unsubscribe = speech.onEvent(handle);
    const refused = () => {
      handle({ session, type: "error", error: "service-not-allowed" });
      handle({ session, type: "end" });
    };
    speech.start(this.lang, session).then((started) => {
      if (!started) refused();
    }, refused);
  }

  stop() {
    if (this.session) void desktopBridge()?.speech?.stop(this.session);
  }

  abort() {
    const session = this.session;
    this.release();
    if (session) void desktopBridge()?.speech?.abort(session);
  }

  private release() {
    this.session = 0;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}
