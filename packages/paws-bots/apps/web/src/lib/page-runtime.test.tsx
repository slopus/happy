// @vitest-environment jsdom

import { QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { usePageDocument } from "./pages";
import { queryClient } from "./query";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ i18n: { locale: "en" }, t: String.raw }),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  queryClient.clear();
  document.body.replaceChildren();
});

it("asks the server for the page runtime again each time a page opens", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response("/*kit-v1*/"))
    .mockResolvedValueOnce(new Response("/*kit-v2*/"));
  vi.stubGlobal("fetch", fetcher);
  let shown: string | null = null;
  function Page() {
    shown = usePageDocument("export default () => null;").document;
    return null;
  }
  const open = async () => {
    const root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <Page />
        </QueryClientProvider>,
      ),
    );
    await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
    return root;
  };
  (await open()).unmount();
  expect(shown).toContain("kit-v1");
  // The browser revalidates the runtime's no-cache response, so a server upgrade shows here.
  await open();
  expect(shown).toContain("kit-v2");
  expect(fetcher).toHaveBeenCalledTimes(2);
});
