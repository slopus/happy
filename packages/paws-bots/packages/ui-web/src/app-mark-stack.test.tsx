// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { AppMarkStack } from "./app-mark-stack.js";

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

it("uses the same inset tile for artwork, missing artwork, and failed artwork", async () => {
  await act(async () =>
    root.render(
      <AppMarkStack
        ringClassName="ring-sidebar-accent"
        marks={[
          { name: "Gmail", logo: "https://example.test/gmail.svg" },
          { name: "Notion" },
          { name: "GitHub", logo: "https://example.test/github.svg" },
        ]}
      />,
    ),
  );
  const stack = host.firstElementChild!;
  const tiles = [...stack.children] as HTMLElement[];
  expect(stack.getAttribute("aria-hidden")).toBe("true");
  expect(tiles).toHaveLength(3);
  expect(new Set(tiles.map((tile) => tile.className)).size).toBe(1);
  for (const tile of tiles) {
    expect(tile.classList.contains("bg-favicon-plate")).toBe(true);
    expect(tile.classList.contains("ring-sidebar-accent")).toBe(true);
    expect(tile.style.width).toBe("24px");
    expect(tile.style.height).toBe("24px");
    expect(tile.style.padding).toBe("4px");
  }
  expect(tiles.map((tile) => tile.style.marginLeft)).toEqual(["0px", "-2px", "-2px"]);
  expect(tiles.map((tile) => tile.style.zIndex)).toEqual(["0", "1", "2"]);
  expect(tiles[1]!.textContent).toBe("N");
  await act(async () => tiles[2]!.querySelector("img")!.dispatchEvent(new Event("error")));
  expect(tiles[2]!.textContent).toBe("G");
  expect(tiles[2]!.querySelector("img")).toBeNull();
  expect(tiles[2]!.className).toBe(tiles[0]!.className);
});

it("scales its geometry and retries replacement artwork", async () => {
  const render = async (logo: string) =>
    act(async () =>
      root.render(
        <AppMarkStack
          size={30}
          ringClassName="ring-card"
          marks={[{ name: "App", logo }, { name: "" }]}
        />,
      ),
    );
  await render("https://example.test/old.svg");
  const tile = host.querySelector<HTMLElement>("span > span")!;
  expect(tile.style.width).toBe("30px");
  expect(tile.style.padding).toBe("5px");
  expect(tile.nextElementSibling?.textContent).toBe("?");
  await act(async () => tile.querySelector("img")!.dispatchEvent(new Event("error")));
  expect(tile.textContent).toBe("A");
  await render("https://example.test/new.svg");
  expect(tile.querySelector("img")?.src).toBe("https://example.test/new.svg");
});
