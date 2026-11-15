// @vitest-environment jsdom

import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => [] as Array<string | null>);

vi.mock("./rpc", () => {
  const clientForSpace = (spaceId: string | null | undefined) => ({
    bots: {
      claimEmailAddress: async ({ name }: { name: string }) => {
        calls.push(
          spaceId === undefined ? window.localStorage.getItem("rakazo:space-id") : spaceId,
        );
        return { address: `${name}@bots.rakazo.test` };
      },
    },
  });
  return {
    createSpaceRpc: clientForSpace,
    rpc: clientForSpace(undefined),
    rpcForSpace: (spaceId: string) => clientForSpace(spaceId),
    selectedSpaceId: () => window.localStorage.getItem("rakazo:space-id"),
  };
});

import { SpaceRpcProvider, useSpaceRpc } from "./space-rpc";

let container: HTMLDivElement;
let root: Root;

function ClaimProbe() {
  const rpc = useSpaceRpc();
  return (
    <button
      type="button"
      onClick={() => void rpc.bots.claimEmailAddress({ botId: "bot-a", name: "scout" })}
    >
      Claim
    </button>
  );
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  calls.length = 0;
  window.localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

async function render(spaceId: string | null | undefined, selectedSpaceId: string) {
  window.localStorage.setItem("rakazo:space-id", selectedSpaceId);
  await act(async () => {
    root.render(
      <SpaceRpcProvider spaceId={spaceId}>
        <ClaimProbe />
      </SpaceRpcProvider>,
    );
  });
}

describe("SpaceRpcProvider", () => {
  it.each([
    { shellSpaceId: "space-a", selectedSpaceId: "space-b", expected: "space-a" },
    { shellSpaceId: null, selectedSpaceId: "space-b", expected: null },
    { shellSpaceId: undefined, selectedSpaceId: "space-b", expected: "space-b" },
  ])("uses the shell's Space scope when selection is $selectedSpaceId", async (scenario) => {
    await render(scenario.shellSpaceId, scenario.selectedSpaceId);
    await act(async () => {
      container.querySelector("button")?.click();
    });
    expect(calls).toEqual([scenario.expected]);
  });

  it.each([
    { parentSpaceId: "space-a", expected: "space-a" },
    { parentSpaceId: null, expected: null },
  ])("inherits the parent scope when a nested provider is unset", async (scenario) => {
    window.localStorage.setItem("rakazo:space-id", "space-b");
    await act(async () => {
      root.render(
        <SpaceRpcProvider spaceId={scenario.parentSpaceId}>
          <SpaceRpcProvider spaceId={undefined}>
            <ClaimProbe />
          </SpaceRpcProvider>
        </SpaceRpcProvider>,
      );
    });
    await act(async () => {
      container.querySelector("button")?.click();
    });
    expect(calls).toEqual([scenario.expected]);
  });
});
