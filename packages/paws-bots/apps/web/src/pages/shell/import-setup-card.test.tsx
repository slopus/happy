// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@rakazo/ui-web", () => ({
  cn: (...values: unknown[]) => values.filter(Boolean).join(" "),
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
    <button type="button" {...props} />
  ),
}));

const importSetupState = vi.fn();
vi.mock("../../lib/rpc", () => ({ rpc: { bots: { importSetupState } } }));

const { ImportSetupCard } = await import("./import-setup-card");

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("the import setup checklist", () => {
  it("lists what each item needs and opens where it is finished", () => {
    importSetupState.mockReturnValue(new Promise(() => undefined));
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const onOpen = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() =>
      root!.render(
        <ImportSetupCard
          onOpen={onOpen}
          block={{
            kind: "import_setup",
            items: [
              { kind: "model", title: "openrouter/example", provider: "openrouter" },
              {
                kind: "mcp",
                serverId: "server-1",
                name: "files",
                needs: [
                  { kind: "program", name: "npx" },
                  { kind: "env", names: ["EXAMPLE_TOKEN"] },
                ],
              },
              { kind: "routine", routineId: "routine-1", name: "morning" },
              {
                kind: "skill",
                name: "triage",
                needs: [{ kind: "requires", names: ["gh", "curl"] }],
              },
            ],
          }}
        />,
      ),
    );
    const rows = [...container.querySelectorAll("li")].map((row) =>
      [...row.querySelectorAll("p")].map((line) => line.textContent),
    );
    expect(rows).toEqual([
      ["openrouter/example", "API key for openrouter"],
      ["files", "Program: npx, Environment variables: EXAMPLE_TOKENCheck this yourself"],
      ["morning", "Paused"],
      ["triage", "Needs: gh, curlCheck this yourself"],
    ]);
    const buttons = [...container.querySelectorAll("button")];
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Open openrouter/example",
      "Open files",
      "Open morning",
    ]);
    for (const button of buttons) act(() => button.click());
    expect(onOpen.mock.calls.map(([target]) => target)).toEqual([
      { kind: "models" },
      { kind: "mcp", serverId: "server-1" },
      { kind: "routine", routineId: "routine-1" },
    ]);
  });
});

describe("the checklist's live state", () => {
  const block = {
    kind: "import_setup",
    items: [
      {
        kind: "mcp",
        serverId: "server-1",
        name: "docs",
        needs: [{ kind: "credentials", names: ["Authorization"] }],
      },
      { kind: "routine", routineId: "routine-1", name: "morning" },
    ],
  } as const;
  async function show() {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <ImportSetupCard botId="bot-1" onOpen={vi.fn()} block={structuredClone(block) as never} />,
      );
    });
    return container;
  }

  it("marks done items from current data and keeps the rest openable", async () => {
    importSetupState.mockResolvedValue({
      providers: {},
      serverIds: { "server-1": true },
      routineIds: { "routine-1": false },
    });
    const container = await show();
    expect(importSetupState).toHaveBeenLastCalledWith({
      botId: "bot-1",
      providers: [],
      serverIds: ["server-1"],
      routineIds: ["routine-1"],
    });
    const rows = [...container.querySelectorAll("li")];
    expect(rows.map((row) => row.dataset.done ?? "")).toEqual(["true", ""]);
    expect(rows[0]!.querySelector("button")).toBeNull();
    expect(rows[1]!.querySelector("button")?.getAttribute("aria-label")).toBe("Open morning");
  });

  it("shrinks to one line when everything is done", async () => {
    importSetupState.mockResolvedValue({
      providers: {},
      serverIds: { "server-1": true },
      routineIds: { "routine-1": true },
    });
    const container = await show();
    const card = container.querySelector("[data-testid='import-setup-card']")!;
    expect(card.getAttribute("data-complete")).toBe("true");
    expect(card.textContent).toBe("Setup complete");
  });
});

describe("rows the checklist cannot check", () => {
  it("never ticks a skill's or a stdio program's needs, and never claims setup is complete", async () => {
    importSetupState.mockResolvedValue({
      providers: { openrouter: true },
      serverIds: { remote: true, stdio: true },
      routineIds: { "routine-1": true },
    });
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <ImportSetupCard
          botId="bot-1"
          onOpen={vi.fn()}
          block={{
            kind: "import_setup",
            items: [
              { kind: "model", title: "openrouter/example", provider: "openrouter" },
              {
                kind: "mcp",
                serverId: "remote",
                name: "docs",
                needs: [{ kind: "credentials", names: ["Authorization"] }],
              },
              {
                kind: "mcp",
                serverId: "stdio",
                name: "files",
                needs: [{ kind: "program", name: "npx" }],
              },
              { kind: "routine", routineId: "routine-1", name: "morning" },
              { kind: "skill", name: "triage", needs: [{ kind: "requires", names: ["gh"] }] },
            ],
          }}
        />,
      );
    });
    const card = container.querySelector("[data-testid='import-setup-card']")!;
    expect(card.getAttribute("data-complete")).toBeNull();
    const rows = [...container.querySelectorAll("li")];
    expect(rows.map((row) => row.dataset.done ?? "")).toEqual(["true", "true", "", "true", ""]);
    expect(rows[2]!.textContent).toContain("Check this yourself");
    expect(rows[4]!.textContent).toContain("Check this yourself");
  });
});

describe("an empty checklist", () => {
  it("never says setup is complete", async () => {
    importSetupState.mockResolvedValue({ providers: {}, serverIds: {}, routineIds: {} });
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <ImportSetupCard botId="bot-1" block={{ kind: "import_setup", items: [] } as never} />,
      );
    });
    expect(container.textContent).not.toContain("Setup complete");
    // Nothing at all, rather than an empty "Finish setting up" card.
    expect(container.innerHTML).toBe("");
  });
});

describe("an undone import's checklist", () => {
  it("is not shown, so it never links to what Undo removed", async () => {
    importSetupState.mockClear();
    importSetupState.mockResolvedValue({ providers: {}, serverIds: {}, routineIds: {} });
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <ImportSetupCard
          botId="bot-1"
          block={{
            kind: "import_setup",
            undone: true,
            items: [{ kind: "routine", routineId: "routine-1", name: "morning" }],
          }}
        />,
      );
    });
    expect(container.innerHTML).toBe("");
    // Nothing is shown, so nothing is fetched.
    expect(importSetupState).not.toHaveBeenCalled();
  });
});
