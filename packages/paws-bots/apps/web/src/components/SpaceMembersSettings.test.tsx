// @vitest-environment jsdom
import type { SpaceMembers } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SpaceMembersSettings } from "./SpaceMembersSettings";

const { rpc, toast } = vi.hoisted(() => ({
  rpc: {
    spaces: {
      members: { list: vi.fn(), remove: vi.fn(), leave: vi.fn() },
      invites: { create: vi.fn(), cancel: vi.fn() },
    },
  },
  toast: vi.fn(),
}));

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => {
  const Plain = ({ children }: { children?: ReactNode }) => <>{children}</>;
  const PlainButton = ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
    <button type="button" {...props} />
  );
  return {
    AlertDialog: Plain,
    AlertDialogAction: PlainButton,
    AlertDialogCancel: PlainButton,
    AlertDialogContent: Plain,
    AlertDialogFooter: Plain,
    AlertDialogHeader: Plain,
    AlertDialogTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
    Badge: Plain,
    Button: PlainButton,
    DropdownMenu: Plain,
    DropdownMenuContent: Plain,
    DropdownMenuItem: PlainButton,
    DropdownMenuTrigger: () => null,
    InputGroup: Plain,
    InputGroupAddon: Plain,
    InputGroupButton: PlainButton,
    InputGroupInput: (props: ComponentProps<"input">) => <input {...props} />,
    toast,
  };
});
vi.mock("../lib/space-rpc", () => ({ useSpaceRpc: () => rpc }));

const owner = {
  userId: "user-owner",
  name: "Ada Lovelace",
  email: "ada@example.test",
  image: null,
  role: "owner" as const,
};
const member = {
  userId: "user-member",
  name: "Bob Stone",
  email: "bob@example.test",
  image: null,
  role: "member" as const,
};
const space = { id: "space-shared", name: "Home" };

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

function buttonNamed(label: string) {
  return [...host.querySelectorAll("button")].find((button) => button.textContent === label);
}

async function renderWith(members: SpaceMembers, onLeft = vi.fn()) {
  rpc.spaces.members.list.mockResolvedValue(members);
  await act(async () => root.render(<SpaceMembersSettings space={space} onLeft={onLeft} />));
  return onLeft;
}

it("lets the owner invite and remove members but not leave", async () => {
  await renderWith({ spaceName: "Home", members: [owner, member], canManage: true });
  expect(buttonNamed("Cancel open invites")).toBeUndefined();
  expect(rpc.spaces.members.list).toHaveBeenCalledWith({ spaceId: space.id });
  const rows = [...host.querySelectorAll('ul[aria-label="Members"] > li')];
  expect(rows.map((row) => row.textContent)).toEqual([
    "AAda LovelaceOwnerada@example.test",
    "BBob Stonebob@example.testRemove",
  ]);
  expect(buttonNamed("Invite")).toBeTruthy();
  expect(buttonNamed("Leave space")).toBeUndefined();
});

it("a member cannot invite or remove, and leaves after confirming", async () => {
  const onLeft = await renderWith({
    spaceName: "Home",
    members: [owner, member],
    canManage: false,
  });
  expect(buttonNamed("Invite")).toBeUndefined();
  expect(buttonNamed("Remove")).toBeUndefined();

  rpc.spaces.members.leave.mockResolvedValue({ ok: true, activeSpaceId: "space-own" });
  await act(async () => buttonNamed("Leave space")?.click());
  expect(host.querySelector("h2")?.textContent).toBe("Leave Home?");
  expect(rpc.spaces.members.leave).not.toHaveBeenCalled();
  await act(async () => buttonNamed("Leave")?.click());
  expect(rpc.spaces.members.leave).toHaveBeenCalledWith({ spaceId: space.id });
  expect(onLeft).toHaveBeenCalledWith("space-own");
});

it("copies a new invite link, and shows it only when copying fails", async () => {
  const writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  await renderWith({ spaceName: "Home", members: [owner], canManage: true });
  rpc.spaces.invites.create.mockResolvedValue({
    url: "https://rakazo.example/invite/token-1",
    expiresAt: new Date().toISOString(),
  });
  const linkField = () => host.querySelector<HTMLInputElement>('input[aria-label="Invite link"]');

  await act(async () => buttonNamed("Invite")?.click());
  expect(rpc.spaces.invites.create).toHaveBeenCalledWith({ spaceId: space.id });
  expect(writeText).toHaveBeenCalledWith("https://rakazo.example/invite/token-1");
  expect(toast).toHaveBeenCalledWith("Invite link copied");
  expect(linkField()).toBeNull();

  writeText.mockRejectedValueOnce(new Error("denied"));
  await act(async () => buttonNamed("Invite")?.click());
  expect(linkField()?.value).toBe("https://rakazo.example/invite/token-1");
  expect(linkField()?.readOnly).toBe(true);
});

it("cancels open invite links only when there are some", async () => {
  await renderWith({ spaceName: "Home", members: [owner], canManage: true, openInvites: 2 });
  rpc.spaces.invites.cancel.mockResolvedValue({ ok: true });
  await act(async () => buttonNamed("Cancel open invites")?.click());
  expect(rpc.spaces.invites.cancel).toHaveBeenCalledWith({ spaceId: space.id });
  expect(buttonNamed("Cancel open invites")).toBeUndefined();
});

it("removes a member only after confirming", async () => {
  await renderWith({ spaceName: "Home", members: [owner, member], canManage: true });
  rpc.spaces.members.remove.mockResolvedValue({ ok: true });

  await act(async () => buttonNamed("Remove")?.click());
  expect(host.querySelector("h2")?.textContent).toBe("Remove Bob Stone?");
  expect(rpc.spaces.members.remove).not.toHaveBeenCalled();

  const confirm = [...host.querySelectorAll("button")].filter(
    (button) => button.textContent === "Remove",
  );
  await act(async () => confirm.at(-1)?.click());
  expect(rpc.spaces.members.remove).toHaveBeenCalledWith({
    spaceId: space.id,
    userId: member.userId,
  });
  expect(host.querySelectorAll('ul[aria-label="Members"] > li')).toHaveLength(1);
  expect(host.querySelector("h2")).toBeNull();
});
