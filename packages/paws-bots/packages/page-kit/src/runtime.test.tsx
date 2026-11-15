// @vitest-environment jsdom
import { act } from "react";
import { expect, it, vi } from "vitest";
import { pageViewerCode } from "./compile.js";
import { checkPageSource } from "./validate.js";

it("mounts a page and reports its height where the browser has no ResizeObserver", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", undefined);
  const posted: unknown[] = [];
  vi.spyOn(window.parent, "postMessage").mockImplementation((message: unknown) => {
    posted.push(message);
  });
  await import("./runtime.js");
  const code = pageViewerCode(
    `const App = () => (\n  <Page title="Hello">\n    <Text>Drawn</Text>\n  </Page>\n);\nexport default App;\n`,
  );
  const page = (window as unknown as { RakazoPage: { mount: (boot: object) => void } }).RakazoPage;
  await act(async () => {
    page.mount({ code, theme: "light", errorTitle: "This page couldn't be shown." });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  // jsdom runs no inline scripts, so the page's own code shows its error panel; what matters is
  // that mounting got that far instead of throwing before anything drew.
  expect(document.body.textContent).toContain("This page couldn't be shown.");
  expect(posted).toContainEqual(expect.objectContaining({ type: "rakazo-page:height" }));
});

it("runs a saved page that declares its own component under a kit component's name", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await import("./runtime.js");
  // jsdom runs no inline scripts, so run the page's script the way a browser would.
  const append = document.head.append.bind(document.head);
  vi.spyOn(document.head, "append").mockImplementation((...nodes) => {
    for (const node of nodes) {
      if (node instanceof HTMLScriptElement) new Function(node.text)();
    }
    append(...nodes);
  });
  const checked = checkPageSource(
    "const Steps = () => <p>Own steps</p>;\nconst App = () => <Steps />;\nexport default App;\n",
  );
  if (!checked.ok) throw new Error(checked.errors.join("\n"));
  document.body.replaceChildren();
  const page = (window as unknown as { RakazoPage: { mount: (boot: object) => void } }).RakazoPage;
  await act(async () => {
    page.mount({ code: checked.code, theme: "light", errorTitle: "This page couldn't be shown." });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(document.body.textContent).toBe("Own steps");
});
