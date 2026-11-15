// @vitest-environment jsdom
import type { ComputerStatus } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ComputerMaintenanceActions } from "./ComputerMaintenanceActions";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings.join("") }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: (props: ComponentProps<"button">) => <button {...props} />,
}));
vi.mock("./ConfirmDialog", () => ({ ConfirmDialog: () => null }));
vi.mock("../lib/computer-updates", () => ({ computerUpdates: { start: vi.fn() } }));
vi.mock("../lib/rpc", () => ({ rpc: { computer: { reset: vi.fn() } } }));

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  host = document.createElement("div");
  root = createRoot(host);
});
afterEach(() => act(() => root.unmount()));

const status = (botId: string) =>
  ({ botId, state: "running", canUpdate: true, busyBotName: null }) as ComputerStatus;
const render = (computer: ComputerStatus) =>
  act(() =>
    root.render(
      <ComputerMaintenanceActions
        botId="bot-settings"
        computer={computer}
        onChanged={async () => {}}
      />,
    ),
  );
const labels = () => [...host.querySelectorAll("button")].map((button) => button.textContent);

it("offers Update and Reset for the bot whose settings are open", async () => {
  await render(status("bot-settings"));
  expect(labels()).toEqual(["Update computer", "Reset computer"]);
});

it("hides the rows when the shared status belongs to another bot's computer", async () => {
  await render(status("bot-peer"));
  expect(labels()).toEqual([]);
});
