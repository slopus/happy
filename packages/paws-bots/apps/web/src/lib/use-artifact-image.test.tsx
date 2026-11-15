// @vitest-environment jsdom
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ArtifactTarget } from "./artifact-open";
import { rpc } from "./rpc";
import { useArtifactImage } from "./use-artifact-image";

vi.mock("./rpc", () => ({ rpc: { artifacts: { get: vi.fn() } } }));

let container: HTMLDivElement;
let root: Root;
const createObjectURL = vi.fn(() => "blob:photo");
const revokeObjectURL = vi.fn();
const artifact = { contentBase64: "AA==", mimeType: "image/png" };

function Image({ target, enabled = true }: { target: ArtifactTarget; enabled?: boolean }) {
  const src = useArtifactImage(target, "photo", enabled);
  return src ? <img src={src} alt="" /> : null;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
  vi.mocked(rpc.artifacts.get).mockResolvedValue(artifact as never);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("shares pending and completed downloads until the last consumer leaves", async () => {
  let finish!: (value: never) => void;
  vi.mocked(rpc.artifacts.get).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  act(() =>
    root.render(
      <>
        <Image target={{ botId: "bot" }} />
        <Image target={{ botId: "bot" }} />
      </>,
    ),
  );
  expect(rpc.artifacts.get).toHaveBeenCalledOnce();
  await act(async () => finish(artifact as never));
  expect(createObjectURL).toHaveBeenCalledOnce();
  expect(container.querySelectorAll("img")).toHaveLength(2);
  await act(async () =>
    root.render(
      <>
        <Image target={{ botId: "bot" }} />
        <Image target={{ botId: "bot" }} />
        <Image target={{ botId: "bot" }} />
      </>,
    ),
  );
  expect(rpc.artifacts.get).toHaveBeenCalledOnce();
  act(() => root.render(<Image target={{ botId: "bot" }} />));
  expect(revokeObjectURL).not.toHaveBeenCalled();
  act(() => root.render(null));
  expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:photo");
});

it("separates bot and group scopes and skips disabled consumers", async () => {
  await act(async () =>
    root.render(
      <>
        <Image target={{ botId: "same" }} />
        <Image target={{ groupId: "same" }} />
        <Image target={{ botId: "other" }} enabled={false} />
      </>,
    ),
  );
  expect(rpc.artifacts.get).toHaveBeenCalledTimes(2);
  expect(rpc.artifacts.get).toHaveBeenCalledWith({ botId: "same", artifactId: "photo" });
  expect(rpc.artifacts.get).toHaveBeenCalledWith({ groupId: "same", artifactId: "photo" });
});

it("releases a download that finishes after all consumers unmount", async () => {
  let finish!: (value: never) => void;
  vi.mocked(rpc.artifacts.get).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  act(() => root.render(<Image target={{ botId: "bot" }} />));
  act(() => root.render(null));
  await act(async () => finish(artifact as never));
  expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:photo");
  vi.mocked(rpc.artifacts.get).mockResolvedValue(artifact as never);
  await act(async () => root.render(<Image target={{ botId: "bot" }} />));
  expect(rpc.artifacts.get).toHaveBeenCalledTimes(2);
});

it("allows retrying a failed download after its consumers leave", async () => {
  vi.mocked(rpc.artifacts.get).mockRejectedValueOnce(new Error("unavailable"));
  await act(async () => root.render(<Image target={{ botId: "bot" }} />));
  expect(container.querySelector("img")).toBeNull();
  act(() => root.render(null));
  await act(async () => root.render(<Image target={{ botId: "bot" }} />));
  expect(container.querySelector("img")).not.toBeNull();
  expect(rpc.artifacts.get).toHaveBeenCalledTimes(2);
});

it("retries a failed download while its original consumer stays mounted", async () => {
  vi.mocked(rpc.artifacts.get).mockRejectedValueOnce(new Error("unavailable"));
  await act(async () => root.render(<Image key="first" target={{ botId: "bot" }} />));
  expect(container.querySelector("img")).toBeNull();
  expect(rpc.artifacts.get).toHaveBeenCalledOnce();

  await act(async () =>
    root.render(
      <>
        <Image key="first" target={{ botId: "bot" }} />
        <Image key="second" target={{ botId: "bot" }} />
      </>,
    ),
  );
  expect(rpc.artifacts.get).toHaveBeenCalledTimes(2);
  expect(container.querySelectorAll("img")).toHaveLength(1);
  expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:photo");
});
