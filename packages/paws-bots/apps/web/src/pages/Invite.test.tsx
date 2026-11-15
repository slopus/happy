// @vitest-environment jsdom
import { ORPCError } from "@orpc/client";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { InvitePage } from "./Invite";

const { preview, accept, selectSpace } = vi.hoisted(() => ({
  preview: vi.fn(),
  accept: vi.fn(),
  selectSpace: vi.fn(() => true),
}));

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({ variant: _variant, ...props }: ComponentProps<"button"> & { variant?: string }) => (
    <button {...props} />
  ),
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(" "),
}));
vi.mock("./Auth", () => ({
  submitClass: "",
  AuthFrame: ({
    title,
    onSubmit,
    children,
  }: {
    title: ReactNode;
    onSubmit: (event: React.FormEvent) => void;
    children: ReactNode;
  }) => (
    <form onSubmit={onSubmit}>
      <h1>{title}</h1>
      {children}
    </form>
  ),
}));
vi.mock("../lib/rpc", () => ({
  rpc: { spaces: { invites: { preview, accept } } },
  selectSpace,
}));

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function render() {
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={["/invite/token-1"]}>
        <Routes>
          <Route path="/invite/:token" element={<InvitePage />} />
          <Route path="/app" element={<p>App</p>} />
        </Routes>
      </MemoryRouter>,
    ),
  );
}

async function submit() {
  await act(async () => host.querySelector("form")?.requestSubmit());
}

it("joins the space and opens it", async () => {
  preview.mockResolvedValue({
    spaceId: "space-shared",
    spaceName: "Home",
    inviterName: "Ada",
    alreadyMember: false,
  });
  accept.mockResolvedValue({ spaceId: "space-shared" });
  await render();
  // Without the remembered space, so recovery from a stale one cannot lose the invite.
  expect(preview).toHaveBeenCalledWith({ token: "token-1" }, { context: { spaceId: null } });
  expect(host.querySelector("h1")?.textContent).toBe("Join Home");
  expect(host.textContent).toContain("Ada invited you");
  expect(accept).not.toHaveBeenCalled();

  await submit();
  expect(accept).toHaveBeenCalledWith({ token: "token-1" }, { context: { spaceId: null } });
  expect(selectSpace).toHaveBeenCalledWith("space-shared");
  expect(host.textContent).toBe("App");
});

it("opens the space straight away for someone already in it", async () => {
  preview.mockResolvedValue({
    spaceId: "space-shared",
    spaceName: "Home",
    inviterName: "Ada",
    alreadyMember: true,
  });
  await render();
  expect(accept).not.toHaveBeenCalled();
  expect(selectSpace).toHaveBeenCalledWith("space-shared");
  expect(host.textContent).toBe("App");
});

it("says a used or expired link is no longer valid", async () => {
  preview.mockRejectedValue(new ORPCError("NOT_FOUND"));
  await render();
  expect(host.querySelector("h1")?.textContent).toBe("This invite link is no longer valid.");
  await submit();
  expect(selectSpace).not.toHaveBeenCalled();
  expect(host.textContent).toBe("App");
});

it("offers a retry when the server cannot be reached", async () => {
  preview.mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValueOnce({
    spaceId: "space-shared",
    spaceName: "Home",
    inviterName: "Ada",
    alreadyMember: false,
  });
  await render();
  expect(host.querySelector("button")?.textContent).toBe("Retry");
  await submit();
  expect(host.querySelector("h1")?.textContent).toBe("Join Home");
});
