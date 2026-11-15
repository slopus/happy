// @vitest-environment jsdom

import type { AgentSkillCatalogEntry } from "@rakazo/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn(), get: vi.fn() }));
const memoryApi = vi.hoisted(() => ({
  list: vi.fn(async () => []),
  remove: vi.fn(),
  update: vi.fn(),
  budget: vi.fn(async () => ({
    limitBytes: 32768,
    usedBytes: 0,
    documents: [],
    omitted: [],
  })),
}));
// One space, so no "Available in" choice appears.
vi.mock("../components/integrations/space-availability", () => ({
  AvailabilityControl: () => null,
  AvailabilityLabel: () => null,
  reachesOtherSpaces: () => false,
  useOwnSpaces: () => [],
}));

vi.mock("../lib/rpc", () => {
  const client = { agentSkills: api, memory: memoryApi };
  return {
    rpc: client,
    rpcForSpace: () => client,
    createSpaceRpc: () => client,
    selectedSpaceId: () => null,
  };
});
vi.mock("../lib/artifact-open", () => ({ downloadArtifactBytes: vi.fn() }));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) => String.raw(parts, ...values);
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@rakazo/ui-web", () => {
  const Container = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Button: ({ variant: _variant, ...props }: ComponentProps<"button"> & { variant?: string }) => (
      <button {...props} />
    ),
    SectionHeading: ({
      variant: _variant,
      ...props
    }: ComponentProps<"h3"> & { variant?: string }) => <h3 {...props} />,
    Textarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
    Skeleton: Container,
    Tabs: Container,
    TabsList: Container,
    TabsTrigger: Container,
    TabsContent: Container,
    Badge: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  };
});

import { downloadArtifactBytes } from "../lib/artifact-open";
import { spaceQueries } from "../lib/query";
import { AgentSkills, KnowledgeSection } from "./KnowledgeSection";

const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
let queryClient = newClient();

afterEach(() => {
  queryClient.clear();
  queryClient = newClient();
});

async function settle() {
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

async function show(root: Root, node: ReactNode) {
  await act(async () =>
    root.render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>),
  );
  await settle();
}

it("disables skill rows while a completed save is refreshing the catalog", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const skill = {
    id: "skill-fixture",
    name: "greeting",
    description: "Greet politely",
    content: "Hello",
  };
  let finishRefresh!: (value: (typeof skill)[]) => void;
  const refresh = new Promise<(typeof skill)[]>((resolve) => {
    finishRefresh = resolve;
  });
  api.list.mockResolvedValueOnce([skill]).mockReturnValueOnce(refresh);
  api.create.mockResolvedValue(skill);
  api.get.mockResolvedValue(skill);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const button = (text: string) => {
    const found = [...container.querySelectorAll("button")].find((entry) =>
      entry.textContent?.includes(text),
    );
    if (!found) throw new Error(`Missing button: ${text}`);
    return found;
  };
  try {
    await show(root, <AgentSkills />);
    await act(async () => button("New skill").click());
    await act(async () => button("Save").click());
    expect(api.create).toHaveBeenCalledOnce();
    expect(api.list).toHaveBeenCalledTimes(2);
    expect(button("greeting").disabled).toBe(true);
    await act(async () => button("greeting").click());
    expect(api.get).not.toHaveBeenCalled();
    await act(async () => finishRefresh([skill]));
    expect(button("greeting").disabled).toBe(false);
    await act(async () => button("greeting").click());
    expect(container.querySelector("textarea")?.value).toBe("Hello");
  } finally {
    await act(async () => {
      finishRefresh([skill]);
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("badges built-in skills and leaves plugin skills to their plugin", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const catalog: AgentSkillCatalogEntry[] = [
    {
      id: "builtin:interrogate",
      name: "Interrogate",
      description: "Review a change",
      source: "builtin",
      readOnly: true,
    },
    {
      id: "plugin:mail",
      name: "Triage mail",
      description: "Sort the inbox",
      source: "plugin",
      readOnly: true,
    },
    {
      id: "user-1",
      name: "greeting",
      description: "Greet politely",
      source: "user",
      readOnly: false,
    },
  ];
  api.list.mockReset();
  api.get.mockReset();
  api.list.mockResolvedValueOnce(catalog);
  api.get.mockImplementation(async ({ skillId }: { skillId: string }) => {
    const entry = catalog.find((skill) => skill.id === skillId);
    if (!entry) throw new Error(`Missing skill: ${skillId}`);
    return { ...entry, content: "Steps", createdAt: "", updatedAt: "" };
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const button = (text: string) => {
    const found = [...container.querySelectorAll("button")].find((entry) =>
      entry.textContent?.includes(text),
    );
    if (!found) throw new Error(`Missing button: ${text}`);
    return found;
  };
  try {
    await show(root, <AgentSkills />);
    expect(button("Interrogate").textContent).toContain("Built-in");
    // Plugin skills are listed by their plugin in the Skills dialog, not one by one here.
    expect(container.textContent).not.toContain("Triage mail");
    expect(button("greeting").textContent).not.toContain("Built-in");
    expect(button("greeting").textContent).not.toContain("Plugin");
    await act(async () => button("Interrogate").click());
    expect(container.querySelector("textarea")?.readOnly).toBe(true);
    expect(container.textContent).toContain("Built-in");
    expect(button("Close")).toBeTruthy();
    expect(container.textContent).not.toContain("Delete");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("deletes a bot memory document after confirmation but never MEMORY.md", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const doc = (id: string, path: string) => ({
    id,
    scope: "bot" as const,
    botId: "bot-fixture",
    path,
    content: `# ${path}`,
    revision: 1,
    updatedAt: "",
  });
  api.list.mockReset();
  api.list.mockResolvedValue([]);
  memoryApi.list.mockResolvedValueOnce([
    doc("memory-index", "MEMORY.md"),
    doc("memory-project", "projects/retired.md"),
  ] as never);
  memoryApi.remove.mockResolvedValue({ ok: true });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const button = (text: string) => {
    const found = [...container.querySelectorAll("button")].find((entry) =>
      entry.textContent?.includes(text),
    );
    if (!found) throw new Error(`Missing button: ${text}`);
    return found;
  };
  try {
    await show(root, <KnowledgeSection botId="bot-fixture" />);
    await act(async () => button("MEMORY.md").click());
    expect(container.textContent).not.toContain("Delete");
    await act(async () => button("projects/retired.md").click());
    await act(async () => button("Delete").click());
    expect(memoryApi.remove).not.toHaveBeenCalled();
    await act(async () => button("Confirm delete").click());
    expect(memoryApi.remove).toHaveBeenCalledWith({ documentId: "memory-project" });
    expect(container.textContent).not.toContain("projects/retired.md");
    expect(container.textContent).toContain("MEMORY.md");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("downloads only each row’s saved markdown with its own filename", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const doc = {
    id: "memory-fixture",
    scope: "bot",
    botId: "bot-fixture",
    path: "MEMORY.md",
    content: "Fixture memory",
    revision: 1,
    updatedAt: "",
  };
  memoryApi.list
    .mockReset()
    .mockResolvedValue([
      doc,
      { ...doc, id: "other-fixture", path: "projects/notes.md", content: "Other document" },
    ] as never);
  api.list.mockResolvedValue([]);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await show(root, <KnowledgeSection botId="bot-fixture" />);
    const download = container.querySelector<HTMLButtonElement>('[aria-label="Download"]')!;
    expect(download).not.toBeNull();
    expect(download.parentElement?.textContent).toContain("MEMORY.md");
    memoryApi.list.mockResolvedValueOnce([
      { ...doc, content: "Latest saved memory", revision: 2 },
      { ...doc, id: "other-fixture", path: "projects/notes.md", content: "Other document" },
    ] as never);
    await act(async () => download.click());
    expect(memoryApi.list).toHaveBeenCalledTimes(2);
    expect(downloadArtifactBytes).toHaveBeenLastCalledWith(
      "MEMORY.md",
      "text/markdown",
      new TextEncoder().encode("Latest saved memory"),
    );
    const downloads = container.querySelectorAll<HTMLButtonElement>('[aria-label="Download"]');
    await act(async () => downloads[1]!.click());
    expect(downloadArtifactBytes).toHaveBeenLastCalledWith(
      "notes.md",
      "text/markdown",
      new TextEncoder().encode("Other document"),
    );
    expect(container.querySelector("h3")?.textContent).toBe("Memory");
    expect(container.querySelector("textarea")).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("hides empty bot memory and limits long lists to five documents", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    memoryApi.list.mockReset().mockResolvedValueOnce([]);
    await show(root, <KnowledgeSection key="empty" botId="fixture" />);
    expect(host.textContent).toBe("");
    memoryApi.list.mockResolvedValueOnce(
      Array.from({ length: 7 }, (_, i) => ({
        id: `doc-${i}`,
        path: `notes/${i}.md`,
        content: "Fixture",
        revision: 1,
        scope: "bot",
        botId: "fixture",
        updatedAt: "",
      })) as never,
    );
    await show(root, <KnowledgeSection key="busy" botId="fixture" />);
    expect(host.textContent).not.toContain("notes/6.md");
    await act(async () =>
      [...host.querySelectorAll("button")]
        .find((node) => node.textContent === "Show more")!
        .click(),
    );
    expect(host.textContent).toContain("notes/6.md");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it.each([" \n", "# Fixture\n\n"])("hides empty memory: %j", async (content) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  memoryApi.list.mockResolvedValueOnce([{ id: "empty", path: "MEMORY.md", content }] as never);
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await show(root, <KnowledgeSection botId="fixture" />);
    expect(host.textContent).not.toContain("Memory");
    expect(host.textContent).not.toContain("MEMORY.md");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it("keeps the last cleared memory document available to reopen in the session", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const doc = { id: "memory", path: "MEMORY.md", content: "Saved memory", revision: 1 };
  memoryApi.list.mockReset().mockResolvedValueOnce([doc] as never);
  memoryApi.update.mockResolvedValueOnce({ ...doc, content: "", revision: 2 });
  const host = document.createElement("div");
  const root = createRoot(host);
  const button = (text: string) =>
    [...host.querySelectorAll("button")].find((node) => node.textContent === text)!;
  try {
    await show(root, <KnowledgeSection botId="fixture" />);
    await act(async () => button("MEMORY.md").click());
    await act(async () => {
      const field = host.querySelector("textarea")!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, "");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button("Save").click());
    expect(memoryApi.update).toHaveBeenCalledWith({
      documentId: "memory",
      content: "",
      expectedRevision: 1,
    });
    expect(host.textContent).toContain("MEMORY.md");
    await act(async () => button("MEMORY.md").click());
    expect(host.querySelector("textarea")?.value).toBe("");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it.each(["missing", "failed"])(
  "does not export cached memory when the current read is %s",
  async (result) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const doc = { id: "memory", path: "MEMORY.md", content: "Cached memory", revision: 1 };
    memoryApi.list.mockReset().mockResolvedValueOnce([doc] as never);
    vi.mocked(downloadArtifactBytes).mockClear();
    const host = document.createElement("div");
    const root = createRoot(host);
    try {
      await show(root, <KnowledgeSection botId="fixture" />);
      if (result === "missing") memoryApi.list.mockResolvedValueOnce([]);
      else memoryApi.list.mockRejectedValueOnce(new Error("offline"));
      await act(async () =>
        host.querySelector<HTMLButtonElement>('[aria-label="Download"]')!.click(),
      );
      expect(downloadArtifactBytes).not.toHaveBeenCalled();
      expect(host.textContent).toContain("Could not load");
    } finally {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
    }
  },
);

it("opens skills from the composer's cached list and saves back into it", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const entry = (id: string, name: string): AgentSkillCatalogEntry => ({
    id,
    name,
    description: "",
    source: "user",
    readOnly: false,
  });
  const sharedKey = spaceQueries(null, null).agentSkills.list.queryKey();
  queryClient.setQueryData(sharedKey, [entry("cached", "cached-skill")]);
  let resolveRead: (skills: AgentSkillCatalogEntry[]) => void = () => undefined;
  api.list
    .mockReset()
    .mockImplementationOnce(() => new Promise((resolve) => (resolveRead = resolve)))
    .mockResolvedValueOnce([entry("cached", "cached-skill"), entry("new", "new-skill")]);
  api.create.mockReset().mockResolvedValue(entry("new", "new-skill"));
  const host = document.createElement("div");
  const root = createRoot(host);
  const button = (text: string) =>
    [...host.querySelectorAll("button")].find((node) => node.textContent?.includes(text));
  try {
    await show(root, <AgentSkills />);
    expect(button("cached-skill")).toBeTruthy();
    expect(api.list).toHaveBeenCalledTimes(1);
    await act(async () => button("New skill")!.click());
    await act(async () => button("Save")!.click());
    await settle();
    await act(async () => resolveRead([entry("cached", "cached-skill")]));
    await settle();
    expect(button("new-skill")).toBeTruthy();
    expect(queryClient.getQueryData(sharedKey)?.map((skill) => skill.id)).toEqual([
      "cached",
      "new",
    ]);
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it("says how much memory no longer reaches the bot", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    memoryApi.list.mockReset().mockResolvedValue([
      {
        id: "doc-1",
        path: "MEMORY.md",
        content: "Fixture memory",
        revision: 1,
        scope: "bot",
        botId: "fixture",
        updatedAt: "",
      },
    ] as never);
    memoryApi.budget.mockResolvedValue({
      limitBytes: 32768,
      usedBytes: 32768,
      documents: [
        {
          scope: "bot",
          path: "MEMORY.md",
          revision: 1,
          totalBytes: 40960,
          includedBytes: 30720,
          truncated: true,
        },
      ],
      omitted: [
        {
          scope: "bot",
          path: "notes/old.md",
          revision: 1,
          totalBytes: 10240,
          includedBytes: 0,
          truncated: false,
        },
      ],
    } as never);

    await show(root, <KnowledgeSection botId="fixture" />);

    expect(host.textContent).toContain("About 20 KB of memory no longer reaches the bot.");
  } finally {
    memoryApi.budget.mockReset().mockResolvedValue({
      limitBytes: 32768,
      usedBytes: 0,
      documents: [],
      omitted: [],
    });
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
