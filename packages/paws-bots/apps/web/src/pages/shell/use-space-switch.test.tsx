// @vitest-environment jsdom
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import type { NavigateFunction } from "react-router-dom";
import { BrowserRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as SpaceSwitch from "../../lib/space-switch";
import { useShellNavigation } from "./use-shell-navigation";
import { useOpenSpaceChat } from "./use-space-switch";

const state = vi.hoisted(() => ({
  prime: vi.fn(),
  discard: vi.fn(),
  select: vi.fn(),
  cached: vi.fn(),
  call: vi.fn(),
  remount: vi.fn(),
  stop: vi.fn(),
}));
vi.mock("../../lib/bootstrap", () => ({
  primeSpaceBootstrap: state.prime,
  discardPrimedBootstrap: state.discard,
}));
vi.mock("../../lib/bootstrap-target", () => ({
  initialBootstrapTarget: () => ({ botId: "target" }),
}));
vi.mock("../../lib/call-session", () => ({ getSnapshot: state.call }));
vi.mock("../../lib/organizations", () => ({ leaveOrganization: async () => {} }));
vi.mock("../../lib/query", () => ({
  queryClient: { getQueryData: state.cached },
  spaceSeedKey: () => [],
}));
vi.mock("../../lib/rpc", () => ({ selectedSpaceId: () => "old-space", selectSpace: state.select }));
vi.mock("../../lib/tts", () => ({ speaker: { stop: state.stop } }));
vi.mock("../../lib/space-switch", async (importOriginal) => ({
  ...(await importOriginal<typeof SpaceSwitch>()),
  remountShellForSpace: state.remount,
}));

let root: Root;
let open: ReturnType<typeof useOpenSpaceChat>;
let pending: Array<() => void>;
let commits: Array<() => boolean>;
let navigationRevision: { current: number };
let overlayRevision: { current: number };
let navigate: ReturnType<typeof vi.fn>;

function Harness() {
  open = useOpenSpaceChat({
    bootstrapSpaceId: "old-space",
    userId: "user",
    navigate: navigate as NavigateFunction,
    navigationRevision,
    overlayRevision,
    closeMobileSidebar: () => {},
  });
  return null;
}

async function ready(index = 0) {
  await act(async () => {
    pending[index]!();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.history.replaceState({ idx: 0 }, "", "/app/old");
  pending = [];
  commits = [];
  navigationRevision = { current: 0 };
  overlayRevision = { current: 0 };
  navigate = vi.fn();
  state.prime.mockImplementation(() => new Promise<void>((resolve) => pending.push(resolve)));
  state.cached.mockReturnValue(undefined);
  state.call.mockReturnValue(null);
  state.select.mockReturnValue(true);
  state.remount.mockImplementation((commit: () => boolean) => commits.push(commit));
  root = createRoot(document.createElement("div"));
  act(() => root.render(<Harness />));
});
afterEach(() => {
  act(() => root.unmount());
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("pending space switches", () => {
  it("keeps a switch when an empty space automatically redirects to the same route", async () => {
    window.history.replaceState({ idx: 0 }, "", "/app");
    let redirect!: ReturnType<typeof useShellNavigation>["redirectKeepingOverlay"];
    function NavigationHarness() {
      const navigation = useShellNavigation();
      redirect = navigation.redirectKeepingOverlay;
      open = useOpenSpaceChat({
        ...navigation,
        bootstrapSpaceId: "old-space",
        userId: "user",
        closeMobileSidebar: () => {},
      });
      return null;
    }
    act(() =>
      root.render(
        <BrowserRouter>
          <NavigationHarness />
        </BrowserRouter>,
      ),
    );
    act(() => open("new-space", "/app/new"));
    act(() => redirect("/app"));
    await ready();
    expect(commits).toHaveLength(1);
    act(() => expect(commits[0]!()).toBe(true));
    expect(window.location.pathname).toBe("/app/new");
    expect(state.select).toHaveBeenCalledWith("new-space");
  });

  it("does not carry an overlay that was already open before switching", async () => {
    window.history.replaceState({ idx: 0 }, "", "/app/old?skills");
    act(() => open("new-space", "/app/new"));
    await ready();
    expect(commits[0]!()).toBe(true);
    expect(navigate).toHaveBeenCalledWith("/app/new");
  });

  it("carries a Skills overlay opened while the transition waits", async () => {
    act(() => open("new-space", "/app/new"));
    await ready();
    overlayRevision.current++;
    window.history.replaceState({ idx: 0 }, "", "/app/old?skills");
    expect(commits[0]!()).toBe(true);
    expect(navigate).toHaveBeenCalledWith("/app/new?skills");
  });

  it("does not carry an unrelated plan flag when an overlay changes", async () => {
    window.history.replaceState({ idx: 0 }, "", "/app/old?plans");
    act(() => open("new-space", "/app/new"));
    await ready();
    overlayRevision.current++;
    window.history.replaceState({ idx: 0 }, "", "/app/old?plans&skills");
    expect(commits[0]!()).toBe(true);
    expect(navigate).toHaveBeenCalledWith("/app/new?skills");
  });

  it("does not reopen an overlay that was closed during the transition", async () => {
    act(() => open("new-space", "/app/new"));
    await ready();
    overlayRevision.current++;
    window.history.replaceState({ idx: 0 }, "", "/app/old?skills");
    overlayRevision.current++;
    window.history.replaceState({ idx: 0 }, "", "/app/old");
    expect(commits[0]!()).toBe(true);
    expect(navigate).toHaveBeenCalledWith("/app/new");
  });

  it("abandons a switch after a newer navigation even on the same path", async () => {
    act(() => open("new-space", "/app/new"));
    await ready();
    navigationRevision.current++;
    expect(commits[0]!()).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
    expect(state.select).not.toHaveBeenCalled();
  });

  it("abandons a pending transition after browser history navigation", async () => {
    act(() => open("new-space", "/app/new"));
    await ready();
    act(() => window.dispatchEvent(new PopStateEvent("popstate")));
    expect(commits[0]!()).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("abandons a switch when a newer history entry keeps the same pathname", async () => {
    act(() => open("new-space", "/app/new"));
    await ready();
    window.history.pushState({ idx: 1 }, "", "/app/old?panel=files");
    expect(commits[0]!()).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
    expect(state.select).not.toHaveBeenCalled();
  });

  it("keeps the newer space request when an older bootstrap completes last", async () => {
    act(() => open("first-space", "/app/first"));
    act(() => open("second-space", "/app/second"));
    await ready(1);
    expect(commits[0]!()).toBe(true);
    await ready(0);
    expect(state.remount).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledExactlyOnceWith("/app/second");
    expect(state.discard).toHaveBeenCalledOnce();
  });

  it("ignores a bootstrap that settles after the shell unmounts", async () => {
    act(() => open("new-space", "/app/new"));
    act(() => root.unmount());
    await ready();
    expect(state.remount).not.toHaveBeenCalled();
    expect(state.discard).toHaveBeenCalledOnce();
    root = createRoot(document.createElement("div"));
  });
});
