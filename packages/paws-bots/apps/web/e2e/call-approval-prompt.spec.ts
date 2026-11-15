import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("a call answers each turn and sends the caller to the screen for an approval", async ({
  page,
}, testInfo) => {
  await signup(page, `call-approval-${Date.now()}@rakazo.test`, "password12", "Call Approval");
  await completeOnboarding(page);
  const call = await startCall(page);

  await say(page, "remember that I like tea");
  await expect(call.getByText("noted — i will keep that in memory.", { exact: true })).toBeVisible({
    timeout: 60_000,
  });
  await finishClip(page);
  await expect(call.getByText("Listening", { exact: true })).toBeVisible();

  await say(page, "show a fetch approval card");
  await expect(
    call.getByText("Review before web_fetch example.test.", { exact: true }),
  ).toBeVisible({ timeout: 60_000 });
  await finishClip(page);
  await expect(call.getByText("Approve or deny it on screen.", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "call-approval-prompt");
});

/** Connects the scripted voice and calls the bot, with the caller's words and playback in the test's hands. */
async function startCall(page: Page) {
  await rpc(page, "voice/connect", { provider: "scripted", apiKey: "fake-call-voice-key" });
  await page.addInitScript(() => {
    // There is no microphone here: the caller's words go straight to the browser recognizer.
    let current: { onresult: ((event: unknown) => void) | null } | null = null;
    class Recognition {
      continuous = false;
      interimResults = false;
      lang = "";
      onresult: ((event: unknown) => void) | null = null;
      onerror = null;
      onend = null;
      start() {
        current = this;
      }
      stop() {
        if (current === this) current = null;
      }
      abort() {
        this.stop();
      }
    }
    // Each clip plays until the test ends it, so the caption being read stays on the card. The
    // scripted clip is not real audio, so its decode error must not end it early.
    const clips: HTMLMediaElement[] = [];
    HTMLMediaElement.prototype.play = function () {
      this.onerror = null;
      clips.push(this);
      return new Promise<void>(() => undefined);
    };
    Object.assign(window, {
      SpeechRecognition: Recognition,
      say: (transcript: string) => {
        if (!current) throw new Error("No recognizer is listening");
        current.onresult?.({ resultIndex: 0, results: [[{ transcript }]] });
      },
      finishClip: () => clips.at(-1)?.dispatchEvent(new Event("ended")),
    });
  });
  const voiceStatus = page.waitForResponse((response) => response.url().includes("/voice/status"));
  await page.reload();
  await voiceStatus;
  await page.getByTestId("call-button").click();
  const call = page.getByTestId("call-view");
  await expect(call.getByText("Listening", { exact: true })).toBeVisible();
  return call;
}

async function say(page: Page, transcript: string) {
  await page.evaluate(
    (text) => (window as unknown as { say(text: string): void }).say(text),
    transcript,
  );
}

async function finishClip(page: Page) {
  await page.evaluate(() => (window as unknown as { finishClip(): void }).finishClip());
}
