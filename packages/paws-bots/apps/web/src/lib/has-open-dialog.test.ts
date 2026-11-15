// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { hasOpenDialog } from "./has-open-dialog";

afterEach(() => {
  document.body.replaceChildren();
});

it.each(['<div role="dialog"></div>', '<div role="alertdialog"></div>', "<dialog open></dialog>"])(
  "detects %s",
  (markup) => {
    document.body.innerHTML = markup;
    expect(hasOpenDialog()).toBe(true);
  },
);

it("ignores closed native dialogs and includes menus only when requested", () => {
  document.body.innerHTML = "<dialog></dialog>";
  expect(hasOpenDialog()).toBe(false);
  document.body.innerHTML += '<div role="menu"></div>';
  expect(hasOpenDialog()).toBe(false);
  expect(hasOpenDialog(document, true)).toBe(true);
});
