import { useEffect } from "react";
import { desktopBridge } from "./desktop";

export interface SupportChat {
  crispWebsiteId: string;
  email: string;
  name: string;
}

type CrispWindow = Window & { $crisp?: unknown[][]; CRISP_WEBSITE_ID?: string };

/** Loads Crisp once and shows it; the returned cleanup hides it again. */
export function showSupportChat(chat: SupportChat, target = window as CrispWindow): () => void {
  if (!target.$crisp) {
    // Commands pushed before the script loads run once it does.
    target.$crisp = [];
    target.CRISP_WEBSITE_ID = chat.crispWebsiteId;
    const script = target.document.createElement("script");
    script.src = "https://client.crisp.chat/l.js";
    script.async = true;
    target.document.head.appendChild(script);
  }
  const crisp = target.$crisp;
  crisp.push(["set", "user:email", [chat.email]]);
  if (chat.name) crisp.push(["set", "user:nickname", [chat.name]]);
  crisp.push(["do", "chat:show"]);
  return () => crisp.push(["do", "chat:hide"]);
}

/** The desktop renderer's policy does not allow Crisp, so the chat is web only. */
export function useSupportChat(chat: SupportChat | null) {
  useEffect(() => {
    if (!chat || desktopBridge()) return;
    return showSupportChat(chat);
  }, [chat]);
}
