import { hostNavigate } from "../paws/runtime";
import { t } from "@lingui/core/macro";
import { newClientId } from "@rakazo/core";
import { desktopBridge } from "./desktop";

type SsoResult = {
  data: { url?: string } | null;
  error: { message?: string; code?: string } | null;
};

export const SSO_CALLBACK_PATH = "/sso/callback";
const SSO_CHANNEL = "rakazo-sso-oauth";
const SSO_TIMEOUT_MS = 5 * 60_000;
let cancelActiveAttempt: (() => void) | undefined;

/** The callback runs before session routing, including failed authentication. */
export function completeSsoCallback(): boolean {
  if (window.location.pathname !== SSO_CALLBACK_PATH) return false;
  const params = new URLSearchParams(window.location.search);
  const nonce = params.get("nonce");
  const returnTo = params.get("returnTo");
  if (!nonce || !returnTo) return true;
  let target: URL;
  try {
    target = new URL(returnTo);
  } catch {
    return true;
  }
  if (target.origin !== window.location.origin || target.pathname === SSO_CALLBACK_PATH)
    return true;
  const error = params.get("error");
  if (error) target.searchParams.set("error", error);
  const channel = new BroadcastChannel(`${SSO_CHANNEL}:${nonce}`);
  channel.postMessage({
    type: error ? "sso-error" : "sso-complete",
    nonce,
    url: target.href,
  });
  channel.close();
  window.close();
  return true;
}

/** Named Electron popups share the app session; normal browsers use Better Auth's redirect. */
export async function runSsoFlow(
  begin: (disableRedirect: boolean, callbackURL: (url: string) => string) => Promise<SsoResult>,
  callbackURLs: readonly string[],
): Promise<SsoResult> {
  if (!desktopBridge()) return begin(false, (url) => url);
  const nonce = newClientId();
  const callbacks = callbackURLs.map((url) => new URL(url, window.location.href));
  const callbackURL = (url: string) => {
    const callback = new URL(SSO_CALLBACK_PATH, window.location.origin);
    callback.searchParams.set("nonce", nonce);
    callback.searchParams.set("returnTo", new URL(url, window.location.href).href);
    return callback.href;
  };
  // Subscribe before opening the popup, as completion can arrive immediately.
  // Like MCP OAuth, this channel survives provider COOP navigation.
  const channel = new BroadcastChannel(`${SSO_CHANNEL}:${nonce}`);
  let popup: Window | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  let rejectCancellation: (error: Error) => void = () => undefined;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  const cancel = () => {
    cancelled = true;
    channel.onmessage = null;
    clearTimeout(timer);
    popup?.close();
    rejectCancellation(new Error("SSO attempt replaced"));
  };
  cancelActiveAttempt?.();
  cancelActiveAttempt = cancel;
  try {
    popup = window.open("about:blank", SSO_CHANNEL, "popup,width=560,height=720");
    if (!popup) throw new Error(t`Could not continue`);
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(t`Could not continue`)), SSO_TIMEOUT_MS);
    });
    const result = await Promise.race([begin(true, callbackURL), cancellation, timeout]);
    if (result.error) return result;
    let target: URL;
    try {
      target = new URL(result.data?.url ?? "");
    } catch {
      throw new Error(t`Could not continue`);
    }
    if (target.protocol !== "https:" && target.origin !== window.location.origin)
      throw new Error(t`Could not continue`);
    popup.location.href = target.href;
    // COOP can sever the handle while authentication continues. Retrying
    // cancels this wait; a closed handle is never a success signal.
    await Promise.race([
      new Promise<void>((resolve) => {
        channel.onmessage = (event: MessageEvent) => {
          const message: unknown = event.data;
          if (!message || typeof message !== "object") return;
          if (!("nonce" in message) || message.nonce !== nonce) return;
          if (
            !("type" in message) ||
            (message.type !== "sso-complete" && message.type !== "sso-error") ||
            !("url" in message) ||
            typeof message.url !== "string"
          )
            return;
          let returned: URL;
          try {
            returned = new URL(message.url);
          } catch {
            return;
          }
          if (
            returned.origin !== window.location.origin ||
            !callbacks.some(
              (callback) =>
                callback.origin === returned.origin && callback.pathname === returned.pathname,
            )
          )
            return;
          hostNavigate(returned.href);
          resolve();
        };
      }),
      cancellation,
      timeout,
    ]);
    return result;
  } catch (error) {
    if (cancelled) return { data: null, error: null };
    throw error;
  } finally {
    if (cancelActiveAttempt === cancel) cancelActiveAttempt = undefined;
    clearTimeout(timer);
    channel.onmessage = null;
    channel.close();
    if (!cancelled) popup?.close();
  }
}
