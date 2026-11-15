// @vitest-environment jsdom
import type { ReactElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Button,
  Checkbox,
  CopyButton,
  copyText,
  Input,
  LinkButton,
  ReplyButton,
  replyText,
  Select,
  TextLink,
  Toggle,
} from "./controls.js";
import { Segmented } from "./data.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let posted: unknown[];
beforeEach(() => {
  host = document.body.appendChild(document.createElement("div"));
  posted = [];
  vi.spyOn(window, "postMessage").mockImplementation((message: unknown) => {
    posted.push(message);
  });
});
afterEach(() => {
  host.remove();
  document.documentElement.removeAttribute("data-reply");
  vi.restoreAllMocks();
});

function render(element: ReactElement) {
  const root = createRoot(host);
  act(() => root.render(element));
  return {
    rerender: (next: ReactElement) => act(() => root.render(next)),
    unmount: () => act(() => root.unmount()),
  };
}
const q = <T extends Element>(selector: string) => host.querySelector<T>(selector);
const click = (element: Element | null) => act(() => (element as HTMLElement).click());

describe("controls", () => {
  it("runs a button's action, draws nothing without a label and ignores a disabled press", () => {
    const onClick = vi.fn();
    render(
      <>
        <Button label="Save" variant="primary" onClick={onClick} />
        <Button label="" onClick={onClick} />
        <Button label="Locked" disabled onClick={onClick} />
      </>,
    );
    const buttons = host.querySelectorAll("button");
    expect([...buttons].map((button) => button.textContent)).toEqual(["Save", "Locked"]);
    expect(buttons[0]!.dataset.variant).toBe("primary");
    click(buttons[0]!);
    click(buttons[1]!);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("offers a reply only where the host has a composer, collapsed and at most 300 characters", () => {
    render(<ReplyButton label="Ask" reply={"  Summarise   the\n tickets "} />);
    expect(q<HTMLButtonElement>("button")!.disabled).toBe(true);

    document.documentElement.setAttribute("data-reply", "");
    host.remove();
    host = document.body.appendChild(document.createElement("div"));
    render(
      <>
        <ReplyButton label="Ask" reply={"  Summarise   the\n tickets "} />
        <ReplyButton label="Use my label" />
        <ReplyButton label="Too long" reply={"x".repeat(301)} />
      </>,
    );
    const [ask, label, long] = host.querySelectorAll("button");
    expect(long!.disabled).toBe(true);
    click(ask!);
    click(label!);
    expect(posted).toEqual([
      { type: "rakazo-page:reply", text: "Summarise the tickets" },
      { type: "rakazo-page:reply", text: "Use my label" },
    ]);
    expect(replyText("x".repeat(300))).toHaveLength(300);
    expect(replyText("   ")).toBeUndefined();
  });

  it("copies through the host, never the page's own clipboard, and shows the text when it cannot", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(async (_text: string) => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const answer = (data: unknown) =>
      act(async () => {
        window.dispatchEvent(new MessageEvent("message", { data }));
        await Promise.resolve();
      });
    render(
      <>
        <CopyButton label="Copy yes" text="yes" />
        <CopyButton label="Copy no" text="no" copiedLabel="Done" />
        <CopyButton label="Copy silent" text="silent" />
      </>,
    );
    const [yes, no, silent] = host.querySelectorAll("button");
    await act(async () => yes!.click());
    const asked = posted as { type: string; id: string; text: string }[];
    expect(asked).toEqual([{ type: "rakazo-page:copy", id: expect.any(String), text: "yes" }]);
    // Another copy's answer, or a forged one for no request, changes nothing.
    await answer({ type: "rakazo-page:copied", id: "other", ok: true });
    expect(yes!.textContent).toBe("Copy yes");
    await answer({ type: "rakazo-page:copied", id: asked[0]!.id, ok: true });
    expect(yes!.textContent).toBe("Copied");
    await act(async () => vi.advanceTimersByTime(1600));
    expect(yes!.textContent).toBe("Copy yes");

    await act(async () => no!.click());
    await answer({ type: "rakazo-page:copied", id: asked[1]!.id, ok: false });
    expect(no!.textContent).toBe("Copy no");
    expect(q(".rk-copy-fallback")!.textContent).toBe("no");

    // A host that never answers counts as blocked, so the reader can still select the text.
    await act(async () => silent!.click());
    await act(async () => vi.advanceTimersByTime(2000));
    expect([...host.querySelectorAll(".rk-copy-fallback")].map((node) => node.textContent)).toEqual(
      ["no", "silent"],
    );
    expect(await copyText("x".repeat(20_001))).toBe(false);
    expect(posted).toHaveLength(3);
    expect(writeText).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("asks the host to open web and mail links and leaves other addresses as text", () => {
    render(
      <>
        <LinkButton label="Open" href="https://example.com/a" />
        <LinkButton label="Docs" href="mailto:a@example.com" variant="text" />
        <LinkButton label="Bad" href="data:text/html,hi" />
        <TextLink href="https://example.com/b">source</TextLink>
        <TextLink href="file:///etc/passwd">plain</TextLink>
      </>,
    );
    const links = host.querySelectorAll("a");
    expect([...links].map((link) => link.textContent)).toEqual(["Open", "Docs", "source"]);
    expect(host.textContent).toContain("Bad");
    expect(host.textContent).toContain("plain");
    for (const link of links) click(link);
    expect(posted).toEqual([
      { type: "rakazo-page:open-link", url: "https://example.com/a" },
      { type: "rakazo-page:open-link", url: "mailto:a@example.com" },
      { type: "rakazo-page:open-link", url: "https://example.com/b" },
    ]);
  });

  it("shows a select's placeholder until a listed value is chosen and reports the choice", () => {
    const onChange = vi.fn();
    const view = render(
      <Select
        label="Region"
        value=""
        onChange={onChange}
        placeholder="Choose a region"
        options={[{ value: "eu", label: "Europe" }, "Asia"]}
      />,
    );
    const select = q<HTMLSelectElement>("select")!;
    expect(q<HTMLLabelElement>("label")!.htmlFor).toBe(select.id);
    expect(select.selectedOptions[0]!.textContent).toBe("Choose a region");
    act(() => {
      select.value = "Asia";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith("Asia");
    view.rerender(<Select value="eu" options={[{ value: "eu", label: "Europe" }]} disabled />);
    expect(q<HTMLSelectElement>("select")!.selectedOptions[0]!.textContent).toBe("Europe");
    expect(q<HTMLSelectElement>("select")!.disabled).toBe(true);
    expect(host.textContent).not.toContain("Choose a region");
  });

  it("reports typed text and makes number inputs numeric, with a number pad on phones", () => {
    const onChange = vi.fn();
    render(<Input label="Seats" value={12} type="number" onChange={onChange} />);
    const input = q<HTMLInputElement>("input")!;
    expect(input.value).toBe("12");
    expect(input.type).toBe("number");
    expect(input.inputMode).toBe("decimal");
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "13");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith("13");
  });

  it("flips a toggle through the page's state and shows a checkbox the reader cannot change", () => {
    const onChange = vi.fn();
    render(
      <>
        <Toggle label="Only active" value={false} onChange={onChange} />
        <Toggle label="Archived" value={true} onChange={onChange} disabled />
        <Checkbox label="Paid" value={true} />
      </>,
    );
    const [on, off] = host.querySelectorAll<HTMLInputElement>('[role="switch"]');
    expect(on!.checked).toBe(false);
    click(on!);
    expect(onChange).toHaveBeenCalledWith(true);
    click(off!);
    expect(onChange).toHaveBeenCalledTimes(1);
    const box = q<HTMLInputElement>('.rk-checkbox input[type="checkbox"]')!;
    expect(box.checked).toBe(true);
    expect(box.disabled).toBe(true);
    expect(box.getAttribute("aria-readonly")).toBe("true");
  });

  it("shows segment counts and keeps the chosen segment when there are too many to list", () => {
    const onChange = vi.fn();
    const many = Array.from({ length: 250 }, (_, index) => `o${index}`);
    const view = render(
      <Segmented
        value="open"
        onChange={onChange}
        options={[{ value: "open", label: "Open", count: 12 }, "All"]}
      />,
    );
    expect(q(".rk-segment-count")!.textContent).toBe("12");
    click(host.querySelectorAll("button")[1]!);
    expect(onChange).toHaveBeenCalledWith("All");
    view.rerender(<Segmented value="o240" options={many} />);
    const buttons = host.querySelectorAll("button");
    expect(buttons).toHaveLength(200);
    expect(q('[aria-pressed="true"]')!.textContent).toBe("o240");
  });
});
