// @vitest-environment jsdom
import { ORPCError } from "@orpc/client";
import type { AccountSecurity } from "@rakazo/contracts";
import { IDENTITY_CONFIRMATION_REQUIRED } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type * as AccountSecurityLib from "../lib/account-security";
import {
  confirmIdentity,
  fetchAccountSecurity,
  requestIdentityCode,
} from "../lib/account-security";
import { useIdentityConfirmation } from "./ConfirmIdentityDialog";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings.join("") }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => {
  const Plain = ({ children }: { children?: ReactNode }) => <>{children}</>;
  return {
    Button: ({ variant: _variant, ...props }: ComponentProps<"button"> & { variant?: string }) => (
      <button {...props} />
    ),
    Dialog: ({
      open,
      onOpenChange,
      children,
    }: {
      open: boolean;
      onOpenChange: (open: boolean) => void;
      children?: ReactNode;
    }) =>
      open ? (
        <div role="dialog">
          {children}
          <button type="button" onClick={() => onOpenChange(false)}>
            Close
          </button>
        </div>
      ) : null,
    DialogContent: Plain,
    DialogHeader: Plain,
    DialogTitle: Plain,
    Input: (props: ComponentProps<"input">) => <input {...props} />,
    Label: ({ htmlFor, children, ...props }: ComponentProps<"label">) => (
      <label htmlFor={htmlFor} {...props}>
        {children}
      </label>
    ),
  };
});
vi.mock("../lib/auth", () => ({ authClient: { signIn: { social: vi.fn() } } }));
vi.mock("../lib/account-security", async (importActual) => ({
  ...(await importActual<typeof AccountSecurityLib>()),
  fetchAccountSecurity: vi.fn(),
  confirmIdentity: vi.fn(async () => undefined),
  requestIdentityCode: vi.fn(async () => undefined),
}));

const security = (overrides: Partial<AccountSecurity>): AccountSecurity => ({
  hasPassword: true,
  passwordChangeEnabled: true,
  freshOidcAuth: false,
  ssoLinked: false,
  emailDeletion: true,
  sso: null,
  ...overrides,
});

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

function Reveal({ action }: { action: () => Promise<string> }) {
  const { withIdentityConfirmation, identityDialog } = useIdentityConfirmation();
  const [value, setValue] = useState("");
  return (
    <>
      <button
        type="button"
        onClick={() =>
          void withIdentityConfirmation(action).then(setValue, (error: { code?: string }) =>
            setValue(`refused ${error.code}`),
          )
        }
      >
        Reveal
      </button>
      <output>{value}</output>
      {identityDialog}
    </>
  );
}

const button = (label: string) =>
  [...host.querySelectorAll("button")].find((item) => item.textContent === label)!;

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function needsConfirmationOnce() {
  return vi
    .fn<() => Promise<string>>()
    .mockRejectedValueOnce(new ORPCError(IDENTITY_CONFIRMATION_REQUIRED, { status: 403 }))
    .mockResolvedValueOnce("revealed");
}

it("asks for the password, then retries the action", async () => {
  vi.mocked(fetchAccountSecurity).mockResolvedValue(security({}));
  const action = needsConfirmationOnce();
  await act(async () => root.render(<Reveal action={action} />));
  await act(async () => button("Reveal").click());
  expect(host.querySelector('[role="dialog"]')?.textContent).toContain("Confirm it's you");
  expect(host.querySelector("#confirm-identity-code")).toBeNull();
  await act(async () => type(host.querySelector("#confirm-identity-password")!, "pass-value"));
  await act(async () => button("Continue").click());
  expect(confirmIdentity).toHaveBeenCalledWith({ password: "pass-value" });
  expect(action).toHaveBeenCalledTimes(2);
  expect(host.querySelector("output")?.textContent).toBe("revealed");
  expect(host.querySelector('[role="dialog"]')).toBeNull();
});

it("emails a code to an account without a password", async () => {
  vi.mocked(fetchAccountSecurity).mockResolvedValue(security({ hasPassword: false }));
  const action = needsConfirmationOnce();
  await act(async () => root.render(<Reveal action={action} />));
  await act(async () => button("Reveal").click());
  expect(host.querySelector("#confirm-identity-password")).toBeNull();
  await act(async () => button("Email me a code").click());
  expect(requestIdentityCode).toHaveBeenCalledTimes(1);
  await act(async () => type(host.querySelector("#confirm-identity-code")!, " 123456 "));
  await act(async () => button("Continue").click());
  expect(confirmIdentity).toHaveBeenCalledWith({ code: "123456" });
  expect(host.querySelector("output")?.textContent).toBe("revealed");
});

it("keeps the dialog open and shows the error when confirmation fails", async () => {
  vi.mocked(fetchAccountSecurity).mockResolvedValue(security({}));
  vi.mocked(confirmIdentity).mockRejectedValueOnce(new Error("Invalid password"));
  const action = needsConfirmationOnce();
  await act(async () => root.render(<Reveal action={action} />));
  await act(async () => button("Reveal").click());
  await act(async () => type(host.querySelector("#confirm-identity-password")!, "wrong"));
  await act(async () => button("Continue").click());
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("Invalid password");
  expect(action).toHaveBeenCalledTimes(1);
});

it("offers SSO to a linked account without a password", async () => {
  vi.mocked(fetchAccountSecurity).mockResolvedValue(
    security({ hasPassword: false, emailDeletion: false, sso: { name: "SSO" }, ssoLinked: true }),
  );
  await act(async () => root.render(<Reveal action={needsConfirmationOnce()} />));
  await act(async () => button("Reveal").click());
  expect(button("Sign in again")).toBeDefined();
  expect(button("Email me a code")).toBeUndefined();
});

it("gives the caller the server's error when the dialog is dismissed", async () => {
  vi.mocked(fetchAccountSecurity).mockResolvedValue(security({}));
  const action = needsConfirmationOnce();
  await act(async () => root.render(<Reveal action={action} />));
  await act(async () => button("Reveal").click());
  await act(async () => button("Close").click());
  expect(host.querySelector('[role="dialog"]')).toBeNull();
  expect(host.querySelector("output")?.textContent).toBe(
    `refused ${IDENTITY_CONFIRMATION_REQUIRED}`,
  );
  expect(action).toHaveBeenCalledTimes(1);
});

it("ignores a confirmation that finishes after its dialog was dismissed", async () => {
  vi.mocked(fetchAccountSecurity).mockResolvedValue(security({}));
  let finish: () => void = () => undefined;
  vi.mocked(confirmIdentity).mockImplementationOnce(
    () => new Promise<void>((resolve) => (finish = resolve)),
  );
  const first = needsConfirmationOnce();
  const second = needsConfirmationOnce();
  await act(async () => root.render(<Reveal action={first} />));
  await act(async () => button("Reveal").click());
  await act(async () => type(host.querySelector("#confirm-identity-password")!, "pass-value"));
  await act(async () => button("Continue").click());
  await act(async () => button("Close").click());
  await act(async () => root.render(<Reveal action={second} />));
  await act(async () => button("Reveal").click());
  await act(async () => finish());
  expect(host.querySelector('[role="dialog"]')).not.toBeNull();
  expect(second).toHaveBeenCalledTimes(1);
  expect(first).toHaveBeenCalledTimes(1);
});

it("lets an account without a password request another code", async () => {
  vi.mocked(fetchAccountSecurity).mockResolvedValue(security({ hasPassword: false }));
  await act(async () => root.render(<Reveal action={needsConfirmationOnce()} />));
  await act(async () => button("Reveal").click());
  await act(async () => button("Email me a code").click());
  await act(async () => type(host.querySelector("#confirm-identity-code")!, "000000"));
  await act(async () => button("Email me a code").click());
  expect(requestIdentityCode).toHaveBeenCalledTimes(2);
  expect(host.querySelector<HTMLInputElement>("#confirm-identity-code")?.value).toBe("");
});

it.each(["google", "apple"])(
  "hides unsupported linked %s identity without email delivery",
  async (id) => {
    vi.mocked(fetchAccountSecurity).mockResolvedValue(
      security({
        hasPassword: false,
        emailDeletion: false,
        linkedProviderIds: [id],
      }),
    );
    await act(async () => root.render(<Reveal action={needsConfirmationOnce()} />));
    await act(async () => button("Reveal").click());
    expect(button("Continue with Provider")).toBeUndefined();
    expect(button("Email me a code")).toBeUndefined();
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
  },
);
