// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return {
    useLingui: () => ({ t }),
    Trans: ({ children }: { children: ReactNode }) => children,
  };
});
vi.mock("@rakazo/ui-web", () => {
  const Box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Button: (props: ComponentProps<"button">) => <button type="button" {...props} />,
    Input: (props: ComponentProps<"input">) => <input {...props} />,
    Field: Box,
    FieldLabel: ({ children, htmlFor }: ComponentProps<"label">) => (
      <label htmlFor={htmlFor}>{children}</label>
    ),
    AlertDialog: Box,
    AlertDialogAction: (props: ComponentProps<"button">) => <button type="button" {...props} />,
    AlertDialogCancel: (props: ComponentProps<"button">) => <button type="button" {...props} />,
    AlertDialogContent: Box,
    AlertDialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
    AlertDialogFooter: Box,
    AlertDialogHeader: Box,
    AlertDialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  };
});
vi.mock("../lib/auth", () => ({ authClient: { $store: { notify: vi.fn() } } }));

import { DeleteOrganizationDialog } from "./OrganizationSettingsPanel";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("enables Delete only once the organization's exact name is typed", async () => {
  const onConfirm = vi.fn(async () => undefined);
  await act(async () =>
    root.render(
      <DeleteOrganizationDialog
        organization={{
          id: "org-work",
          name: "Work",
          defaultSpaceId: "s2",
          spaceIds: ["s2"],
          canManage: true,
        }}
        onCancel={() => undefined}
        onConfirm={onConfirm}
      />,
    ),
  );
  const label = container.querySelector("label")!;
  expect(label.textContent).toBe("Type Work to confirm");
  const input = container.querySelector<HTMLInputElement>(`#${CSS.escape(label.htmlFor)}`)!;
  const remove = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Delete",
  )!;
  expect(remove.disabled).toBe(true);
  for (const wrong of ["work", "Wor", "Work "]) {
    await type(input, wrong);
    expect(remove.disabled).toBe(true);
  }
  await type(input, "Work");
  expect(remove.disabled).toBe(false);
  await act(async () => remove.click());
  expect(onConfirm).toHaveBeenCalledOnce();
});
