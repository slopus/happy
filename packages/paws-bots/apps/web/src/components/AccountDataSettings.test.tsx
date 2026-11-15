// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const accountToken = vi.hoisted(() => vi.fn());

// The dialog itself is tested on its own; here it is a button that confirms it.
vi.mock("./ConfirmIdentityDialog", async () => {
  const { useState } = await import("react");
  const { runWithIdentityConfirmation } = await import("@rakazo/contracts");
  return {
    useIdentityConfirmation: () => {
      const [settle, setSettle] = useState<((confirmed: boolean) => void) | null>(null);
      return {
        withIdentityConfirmation: <T,>(action: () => Promise<T>) =>
          runWithIdentityConfirmation(
            action,
            () => new Promise<boolean>((resolve) => setSettle(() => resolve)),
          ),
        identityDialog: settle ? (
          <button
            type="button"
            data-testid="identity-confirm"
            onClick={() => {
              settle(true);
              setSettle(null);
            }}
          />
        ) : null,
      };
    },
  };
});
vi.mock("../lib/rpc", () => ({
  rpc: { export: { accountToken } },
  recheckSessionOnUnauthorized: () => undefined,
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({ variant: _variant, ...props }: ComponentProps<"button"> & { variant?: string }) => (
    <button type="button" {...props} />
  ),
  Spinner: () => null,
}));
vi.mock("./ai/primitives", () => ({
  SuccessPop: ({ label }: { label: string }) => <span data-testid="success">{label}</span>,
}));

import { AccountDataSettings } from "./AccountDataSettings";

let container: HTMLDivElement;
let root: Root;
const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  accountToken.mockReset();
});

async function render(onImported?: () => Promise<void>) {
  await act(async () => {
    root.render(<AccountDataSettings onImported={onImported} />);
  });
}

function button(name: string) {
  const match = [...container.querySelectorAll("button")].find(
    (element) => element.textContent === name,
  );
  if (!match) throw new Error(`No ${name} button`);
  return match;
}

async function chooseFile(file: File) {
  const input = container.querySelector<HTMLInputElement>('[data-testid="account-import-file"]')!;
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

it("confirms identity before minting the export token, then downloads it by link", async () => {
  const clicked: HTMLAnchorElement[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicked.push(this);
  });
  accountToken
    .mockRejectedValueOnce(
      Object.assign(new Error("Confirm it's you"), { code: "IDENTITY_CONFIRMATION_REQUIRED" }),
    )
    .mockResolvedValueOnce({ token: "tok/en+1" });
  await render();

  await act(async () => button("Export").click());
  expect(clicked).toHaveLength(0);
  await act(async () => {
    container.querySelector<HTMLButtonElement>('[data-testid="identity-confirm"]')!.click();
  });

  expect(accountToken).toHaveBeenCalledTimes(2);
  expect(clicked).toHaveLength(1);
  const link = new URL(clicked[0]!.href);
  expect(link.pathname).toBe("/api/account/export");
  expect(link.searchParams.get("token")).toBe("tok/en+1");
  expect(clicked[0]!.hasAttribute("download")).toBe(true);
  expect(fetchMock).not.toHaveBeenCalled();
});

it("uploads the chosen archive and refreshes spaces", async () => {
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ spaces: [{ id: "space_1", name: "Imported" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  const onImported = vi.fn(async () => undefined);
  await render(onImported);
  const file = new File(["zip"], "rakazo-export.zip", { type: "application/zip" });

  await chooseFile(file);

  expect(fetchMock).toHaveBeenCalledWith("/api/account/import", {
    method: "POST",
    headers: { "content-type": "application/zip" },
    credentials: "include",
    body: file,
  });
  expect(onImported).toHaveBeenCalledTimes(1);
  expect(container.querySelector('[data-testid="success"]')).not.toBeNull();
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

it("shows the server's message when the import is rejected", async () => {
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ error: "This archive is from a newer version." }), {
      status: 400,
      headers: { "content-type": "application/json" },
    }),
  );
  const onImported = vi.fn(async () => undefined);
  await render(onImported);

  await chooseFile(new File(["zip"], "rakazo-export.zip"));

  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "This archive is from a newer version.",
  );
  expect(onImported).not.toHaveBeenCalled();
  expect(button("Import").disabled).toBe(false);
});
