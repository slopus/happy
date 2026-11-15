// @vitest-environment jsdom
import type { PluginSubmission } from "@rakazo/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  submissions: vi.fn(),
  review: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("../lib/rpc", () => ({ rpc: { marketplace: { review: api.review } } }));
vi.mock("../lib/query", () => ({
  useSpaceQueries: () => ({
    marketplace: {
      submissions: {
        key: () => ["submissions"],
        queryOptions: ({ input }: { input: { status: string } }) => ({
          queryKey: ["submissions", input.status],
          queryFn: () => api.submissions(input),
        }),
      },
      catalog: { key: () => ["catalog"] },
    },
  }),
}));
vi.mock("../lib/user-error", () => ({
  errorText: (error: unknown, fallback: string) =>
    error instanceof Error ? error.message : fallback,
}));
vi.mock("../components/integrations/plugin-marketplace", () => ({ PluginLogo: () => null }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => `${text}${values[index - 1] ?? ""}${part}`),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => {
  const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Button: ({
      variant: _variant,
      size: _size,
      ...props
    }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
      <button type="button" {...props} />
    ),
    Dialog: ({ open, children }: { open: boolean; children?: ReactNode }) =>
      open ? <div role="dialog">{children}</div> : null,
    DialogContent: Pass,
    DialogFooter: Pass,
    DialogHeader: Pass,
    DialogTitle: Pass,
    Disclosure: ({ summary, children }: { summary: ReactNode; children: ReactNode }) => (
      <div>
        {summary}
        {children}
      </div>
    ),
    Spinner: () => <span role="status" />,
    Tabs: Pass,
    TabsList: Pass,
    TabsTrigger: Pass,
    Textarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
    toast: { error: api.toastError },
  };
});

import { PluginSubmissionsPanel } from "./PluginSubmissionsPanel";

const submission: PluginSubmission = {
  id: "submission-1",
  email: "maker@example.test",
  name: "Notes",
  website: "https://notes.example.test",
  logo: "https://notes.example.test/logo.png",
  source: "https://github.com/example/notes",
  description: "Daily planning",
  testing: "Ask it to plan a day.",
  claim: null,
  status: "pending",
  reason: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  reviewedAt: null,
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.submissions.mockReset().mockResolvedValue([submission]);
  api.review.mockReset().mockResolvedValue({ ...submission, status: "approved" });
  api.toastError.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <PluginSubmissionsPanel />
      </QueryClientProvider>,
    );
  });
  await vi.waitFor(() => {
    if (!container.querySelector('[data-testid="plugin-submission"]')) throw new Error("Loading");
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function button(name: string, scope: ParentNode = container) {
  const found = [...scope.querySelectorAll("button")].find(
    (node) => node.textContent?.trim() === name,
  );
  if (!found) throw new Error(`Missing button ${name}`);
  return found;
}

it("lists pending submissions with their links", () => {
  expect(api.submissions).toHaveBeenCalledWith({ status: "pending" });
  const row = container.querySelector('[data-testid="plugin-submission"]');
  expect(row?.textContent).toContain("Notes");
  expect(row?.textContent).toContain("Ask it to plan a day.");
  const links = [...(row?.querySelectorAll("a") ?? [])].map((link) => link.getAttribute("href"));
  expect(links).toEqual([submission.source, submission.website, `mailto:${submission.email}`]);
});

it("shows the page a claim is for", async () => {
  api.submissions.mockResolvedValue([
    {
      ...submission,
      source: null,
      testing: null,
      claim: "notes",
      email: "owner@notes.example.test",
    },
  ]);
  await act(async () => root.unmount());
  root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <PluginSubmissionsPanel />
      </QueryClientProvider>,
    );
  });
  await vi.waitFor(() => {
    if (!container.querySelector('a[href="https://rakazo.com/integrations/notes/"]'))
      throw new Error("Loading");
  });
  const row = container.querySelector('[data-testid="plugin-submission"]');
  const links = [...(row?.querySelectorAll("a") ?? [])].map((link) => link.getAttribute("href"));
  expect(links).toEqual([
    "https://rakazo.com/integrations/notes/",
    submission.website,
    "mailto:owner@notes.example.test",
  ]);
  expect(row?.textContent).not.toContain("Testing");
});

it("approves a submission", async () => {
  await act(async () => button("Approve").click());
  expect(api.review).toHaveBeenCalledWith({ id: submission.id, decision: "approve" });
});

it("shows why an approval failed", async () => {
  api.review.mockRejectedValueOnce(
    new Error("Could not preview a supported plugin from this repository"),
  );
  await act(async () => button("Approve").click());
  expect(api.toastError).toHaveBeenCalledWith(
    "Could not preview a supported plugin from this repository",
  );
});

it("rejects only with a reason and sends it", async () => {
  await act(async () => button("Reject").click());
  const dialog = container.querySelector('[role="dialog"]');
  if (!dialog) throw new Error("Missing reject dialog");
  const submit = button("Reject", dialog);
  expect(submit.disabled).toBe(true);
  await act(async () => submit.form?.requestSubmit());
  expect(api.review).not.toHaveBeenCalled();

  const field = dialog.querySelector("textarea");
  if (!field) throw new Error("Missing reason");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
      field,
      "  The repository has no plugin manifest.  ",
    );
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(submit.disabled).toBe(false);
  await act(async () => submit.click());
  expect(api.review).toHaveBeenCalledWith({
    id: submission.id,
    decision: "reject",
    reason: "The repository has no plugin manifest.",
  });
  expect(container.querySelector('[role="dialog"]')).toBeNull();
});
