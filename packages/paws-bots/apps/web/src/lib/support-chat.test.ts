// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { showSupportChat } from "./support-chat.js";

const chat = {
  crispWebsiteId: "c2c27ea6-4fdb-4350-a9fc-4b5b052dc5ec",
  email: "ada@example.com",
  name: "Ada",
};

afterEach(() => {
  document.head.innerHTML = "";
  delete (window as { $crisp?: unknown }).$crisp;
});

it("loads Crisp once for the user and hides it when the paywall leaves", () => {
  const hide = showSupportChat(chat);
  const crisp = (window as { $crisp?: unknown[][] }).$crisp;
  expect(document.head.querySelectorAll("script")).toHaveLength(1);
  expect(document.head.querySelector("script")?.src).toBe("https://client.crisp.chat/l.js");
  expect(crisp).toEqual([
    ["set", "user:email", ["ada@example.com"]],
    ["set", "user:nickname", ["Ada"]],
    ["do", "chat:show"],
  ]);
  hide();
  showSupportChat(chat);
  expect(document.head.querySelectorAll("script")).toHaveLength(1);
  expect(crisp?.slice(3, 4)).toEqual([["do", "chat:hide"]]);
  expect(crisp?.at(-1)).toEqual(["do", "chat:show"]);
});
