// @vitest-environment jsdom
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { activateUiLocale, setCatalogLoadersForTests } from "../../lib/i18n";
import type { createSpaceRpc } from "../../lib/rpc";
import { UI_LOCALES } from "../../lib/ui-locale";
import { useReportedUiLocale } from "./use-reported-ui-locale";

let container: HTMLDivElement;
let root: Root;
const update = vi.fn(async () => ({}));
const rpc = { preferences: { update } } as unknown as ReturnType<typeof createSpaceRpc>;

function Reporter({ saved }: { saved: string | null | undefined }) {
  useReportedUiLocale(rpc, saved);
  return null;
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setCatalogLoadersForTests(
    Object.fromEntries(
      UI_LOCALES.map((locale) => [locale, async () => ({ messages: {} })]),
    ) as never,
  );
  await activateUiLocale("es");
  update.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  setCatalogLoadersForTests(null);
  vi.unstubAllGlobals();
});

it("saves the app language when the account has another, then each one picked", async () => {
  act(() => root.render(<Reporter saved="en" />));
  expect(update).toHaveBeenCalledWith({ locale: "es" });

  await act(() => activateUiLocale("de"));
  expect(update).toHaveBeenLastCalledWith({ locale: "de" });
  expect(update).toHaveBeenCalledTimes(2);
});

it("leaves a matching account and an older server alone", async () => {
  act(() => root.render(<Reporter saved="es" />));
  act(() => root.render(<Reporter saved={undefined} />));
  await act(() => activateUiLocale("fr"));
  expect(update).not.toHaveBeenCalled();
});
