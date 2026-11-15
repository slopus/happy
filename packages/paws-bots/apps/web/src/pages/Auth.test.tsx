// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { authClient } from "../lib/auth";
import type { AuthCapabilities } from "../lib/auth-capabilities";
import { fetchAuthCapabilities } from "../lib/auth-capabilities";
import type * as Passkeys from "../lib/passkeys";
import { usePasskeysSupported } from "../lib/passkeys";
import { clearSpaceSelection } from "../lib/rpc";
import { AuthPage } from "./Auth";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray | { message: string }, ...values: unknown[]) =>
      "message" in strings
        ? strings.message
        : strings.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    children,
    variant,
    size,
    ...props
  }: React.ComponentProps<"button"> & { variant?: string; size?: string }) => (
    <button data-variant={variant ?? "default"} data-size={size} {...props}>
      {children}
    </button>
  ),
  LogoAvatar: () => <svg aria-hidden="true" data-rakazo-logo="" />,
  Input: (props: React.ComponentProps<"input">) => <input {...props} />,
  InputOTP: ({
    maxLength,
    onChange,
    onComplete,
    children: _children,
    ...props
  }: Omit<React.ComponentProps<"input">, "onChange"> & {
    onChange: (value: string) => void;
    onComplete?: (value: string) => void;
  }) => (
    <input
      {...props}
      data-otp=""
      onChange={(event) => {
        onChange(event.target.value);
        if (event.target.value.length === maxLength) onComplete?.(event.target.value);
      }}
    />
  ),
  InputOTPGroup: () => null,
  InputOTPSlot: () => null,
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render }: { render: ReactNode }) => render,
  TooltipContent: () => null,
  Label: ({ children, htmlFor, ...props }: React.ComponentProps<"label">) => (
    <label htmlFor={htmlFor} {...props}>
      {children}
    </label>
  ),
}));
vi.mock("../lib/auth-capabilities", () => ({ fetchAuthCapabilities: vi.fn() }));
vi.mock("../lib/auth", () => ({
  authClient: {
    signIn: {
      social: vi.fn(async () => ({})),
      email: vi.fn(),
      emailOtp: vi.fn(),
      passkey: vi.fn(async () => ({ data: {}, error: null })),
    },
    emailOtp: { sendVerificationOtp: vi.fn() },
  },
}));
vi.mock("../lib/rpc", () => ({ clearSpaceSelection: vi.fn() }));
vi.mock("../lib/passkeys", async (importActual) => ({
  ...(await importActual<typeof Passkeys>()),
  usePasskeysSupported: vi.fn(() => false),
  conditionalPasskeyAvailable: vi.fn(async () => false),
}));
const capabilities: AuthCapabilities = {
  passwordAuth: false,
  sso: { name: "Example", availability: "unavailable" },
  passwordReset: false,
  resetUrl: null,
};
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
  vi.restoreAllMocks();
  delete window.rakazoDesktop;
});
async function render(mode: "in" | "up" | "forgot" = "in", entry = "/") {
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={[entry]}>
        <AuthPage mode={mode} />
      </MemoryRouter>,
    ),
  );
}
async function enter(input: Element | null, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function button(text: string) {
  return [...host.querySelectorAll("button")].find(
    (node) => node.textContent?.replace(/\s+/g, " ").trim() === text,
  )!;
}
async function submit() {
  await act(async () => {
    host.querySelector("form")!.requestSubmit();
  });
}
it.each(["in", "up", "forgot"] as const)(
  "stays blank while capabilities load on %s",
  async (mode) => {
    vi.mocked(fetchAuthCapabilities).mockReturnValue(new Promise(() => undefined));
    await render(mode);
    expect(host.querySelector("input")).toBeNull();
    expect(host.textContent).toBe("");
    expect(host.querySelector("form")).toBeNull();
  },
);
it.each(["in", "up"] as const)("offers SSO and hides credentials on %s", async (mode) => {
  vi.mocked(fetchAuthCapabilities).mockResolvedValue(capabilities);
  await render(mode);
  expect(host.textContent).toContain("Continue with Example");
  expect(host.querySelector("input")).toBeNull();
  const sso = host.querySelector("button")!;
  expect(sso.dataset.variant).toBe("outline");
  expect(sso.className).toContain("w-full");
});
it("retries failed capabilities without exposing a password form", async () => {
  vi.mocked(fetchAuthCapabilities)
    .mockRejectedValueOnce(new Error())
    .mockResolvedValueOnce(capabilities);
  await render();
  expect(host.textContent).toContain("Could not load sign-in options");
  expect(host.querySelector("input")).toBeNull();
  const retry = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Retry",
  )!;
  await act(async () => retry.click());
  expect(fetchAuthCapabilities).toHaveBeenCalledTimes(2);
  expect(host.textContent).toContain("Continue with Example");
});
it.each(["in", "up"] as const)("offers providers before the email form on %s", async (mode) => {
  vi.mocked(fetchAuthCapabilities).mockResolvedValue({ ...capabilities, passwordAuth: true });
  await render(mode);
  const provider = button("Continue with Example");
  const emailChoice = button("Continue with email");
  expect(host.querySelector('input[name="email"]')).toBeNull();
  expect(provider.dataset.variant).toBe("outline");
  expect(provider.className).toContain("w-full");
  expect(emailChoice.dataset.variant).toBe("outline");
  expect(emailChoice.className).toContain("w-full");
  expect(host.querySelector("[data-rakazo-logo]")).not.toBeNull();
  expect(
    provider.compareDocumentPosition(emailChoice) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  await act(async () => emailChoice.click());
  expect(host.querySelector('input[name="email"]')).not.toBeNull();
  expect(button("Back")).toBeDefined();
  await act(async () => button("Back").click());
  expect(host.querySelector('input[name="email"]')).toBeNull();
  expect(button("Continue with Example")).toBeDefined();
});

it("shows a configured provider beside the password form and hides the rest", async () => {
  const mark = { viewBox: "0 0 24 24", paths: [{ d: "M1 1h2v2H1z" }] };
  vi.mocked(fetchAuthCapabilities).mockResolvedValue({
    ...capabilities,
    passwordAuth: true,
    sso: null,
    providers: [
      { id: "google", name: "Google", presentation: { variant: "outline", mark } },
      { id: "apple", name: "Apple", presentation: { variant: "solid", mark } },
    ],
  });
  await render();
  expect(host.querySelector('input[name="email"]')).toBeNull();
  const google = button("Continue with Google");
  const apple = button("Continue with Apple");
  const emailChoice = button("Continue with email");
  expect(google.dataset.variant).toBe("outline");
  expect(apple.dataset.variant).toBe("outline");
  expect(google.parentElement).toBe(apple.parentElement);
  expect(google.parentElement?.className).toContain("flex-col");
  expect(google.querySelector("svg")).not.toBeNull();
  expect(apple.querySelector("svg")).not.toBeNull();
  expect(emailChoice.dataset.variant).toBe("outline");
  expect(emailChoice.className).toContain("w-full");
  expect(host.textContent).toContain("Welcome back");
  expect(host.querySelector("[data-rakazo-logo]")).not.toBeNull();
  await act(async () => google.click());
  expect(authClient.signIn.social).toHaveBeenCalledWith(
    expect.objectContaining({ provider: "google" }),
  );
  await act(async () => emailChoice.click());
  expect(host.querySelector('input[name="email"]')).not.toBeNull();
  vi.mocked(fetchAuthCapabilities).mockResolvedValue({
    ...capabilities,
    passwordAuth: true,
    sso: null,
    providers: [],
  });
  await render("up");
  expect(host.textContent).not.toContain("Continue with");
  expect(host.querySelector('input[name="email"]')).not.toBeNull();
});

it("offers a supported passkey in the sign-in chooser only", async () => {
  vi.mocked(usePasskeysSupported).mockReturnValue(true);
  vi.mocked(fetchAuthCapabilities).mockResolvedValue({ ...capabilities, passwordAuth: true });
  await render();
  const passkey = button("Continue with passkey");
  expect(
    button("Continue with email").compareDocumentPosition(passkey) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  await act(async () => passkey.click());
  expect(authClient.signIn.passkey).toHaveBeenCalledWith({ autoFill: false });
  expect(clearSpaceSelection).toHaveBeenCalled();

  await render();
  await act(async () => button("Continue with email").click());
  expect(button("Sign in with passkey")).toBeUndefined();

  await render("up");
  expect(button("Continue with passkey")).toBeUndefined();
});

it("hides SSO in password recovery", async () => {
  vi.mocked(fetchAuthCapabilities).mockResolvedValue({ ...capabilities, passwordAuth: true });
  await render("forgot");
  expect(host.textContent).not.toContain("Continue with Example");
});

it("selects a non-redirecting SSO request on desktop", async () => {
  vi.spyOn(window, "open").mockReturnValue({ close: vi.fn() } as unknown as Window);
  window.rakazoDesktop = {} as NonNullable<Window["rakazoDesktop"]>;
  vi.mocked(fetchAuthCapabilities).mockResolvedValue(capabilities);
  vi.mocked(authClient.signIn.social).mockResolvedValue({
    data: null,
    error: { message: "Unavailable", status: 503, statusText: "Unavailable" },
  });
  await render();
  const button = Array.from(host.querySelectorAll("button")).find((button) =>
    button.textContent?.includes("Continue with"),
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
  expect(authClient.signIn.social).toHaveBeenCalledWith(
    expect.objectContaining({ provider: "oidc", disableRedirect: true }),
  );
});

it("lets the desktop app change its server from sign in", async () => {
  const change = vi.fn(async () => undefined);
  window.rakazoDesktop = { server: { change } } as unknown as NonNullable<Window["rakazoDesktop"]>;
  vi.mocked(fetchAuthCapabilities).mockResolvedValue(capabilities);
  await render();
  const button = Array.from(host.querySelectorAll("button")).find(
    (button) => button.textContent === "Change server",
  )!;
  await act(async () => button.click());
  expect(change).toHaveBeenCalledOnce();
});

it("offers no server change in a browser", async () => {
  vi.mocked(fetchAuthCapabilities).mockResolvedValue(capabilities);
  await render();
  expect(host.textContent).not.toContain("Change server");
});

it("keeps SSO available for retry while an authorization request is pending", async () => {
  vi.mocked(fetchAuthCapabilities).mockResolvedValue(capabilities);
  vi.mocked(authClient.signIn.social).mockReturnValue(new Promise(() => undefined));
  await render();
  const button = Array.from(host.querySelectorAll("button")).find((button) =>
    button.textContent?.includes("Continue with"),
  )!;
  await act(async () => button.click());
  expect(button.disabled).toBe(false);
  await act(async () => button.click());
  expect(authClient.signIn.social).toHaveBeenCalledTimes(2);
});

const codeCapabilities: AuthCapabilities = {
  ...capabilities,
  sso: null,
  passwordAuth: true,
  emailCode: true,
};

it("signs in with an emailed code when the password is blank", async () => {
  vi.mocked(fetchAuthCapabilities).mockResolvedValue(codeCapabilities);
  vi.mocked(authClient.emailOtp.sendVerificationOtp).mockResolvedValue({
    data: { success: true },
    error: null,
  } as never);
  vi.mocked(authClient.signIn.emailOtp).mockResolvedValue({ data: {}, error: null } as never);
  await render();
  await enter(host.querySelector('input[name="email"]'), " person@example.com ");
  expect(host.querySelector('button[type="submit"]')!.textContent).toBe("Continue");
  await submit();
  expect(authClient.emailOtp.sendVerificationOtp).toHaveBeenCalledWith({
    email: "person@example.com",
    type: "sign-in",
  });
  expect(host.querySelector("h1")!.textContent).toBe("Check your email");
  const code = host.querySelector('input[aria-label="Code"]')!;
  expect(code.getAttribute("autocomplete")).toBe("one-time-code");
  await enter(code, "123456");
  expect(authClient.signIn.emailOtp).toHaveBeenCalledWith({
    email: "person@example.com",
    otp: "123456",
    name: undefined,
  });
  // The session refetch moves a signed-in user on; until then the form stays busy.
  expect(clearSpaceSelection).toHaveBeenCalled();
  expect(button("Working…").disabled).toBe(true);
});

it("keeps an invite as the destination when switching to sign-in", async () => {
  vi.mocked(fetchAuthCapabilities).mockResolvedValue(codeCapabilities);
  await render("up", `/?next=${encodeURIComponent("/invite/token-1")}`);
  expect(host.querySelector('a[href^="/sign-in"]')?.getAttribute("href")).toBe(
    "/sign-in?next=%2Finvite%2Ftoken-1",
  );
});

it("names a new account and keeps the email when going back from the code", async () => {
  vi.mocked(fetchAuthCapabilities).mockResolvedValue(codeCapabilities);
  vi.mocked(authClient.emailOtp.sendVerificationOtp).mockResolvedValue({
    data: { success: true },
    error: null,
  } as never);
  vi.mocked(authClient.signIn.emailOtp)
    .mockResolvedValueOnce({
      data: null,
      error: { code: "INVALID_OTP", message: "Invalid OTP", status: 400, statusText: "" },
    } as never)
    .mockResolvedValueOnce({ data: {}, error: null } as never);
  await render("up");
  await enter(host.querySelector('input[name="name"]'), "Ada");
  await enter(host.querySelector('input[name="email"]'), "ada@example.com");
  await submit();
  await enter(host.querySelector('input[aria-label="Code"]'), "111111");
  expect(host.querySelector('[role="alert"]')!.textContent).toBe("Invalid code");
  await act(async () => button("Back").click());
  expect(host.querySelector<HTMLInputElement>('input[name="email"]')!.value).toBe(
    "ada@example.com",
  );
  await submit();
  expect(authClient.emailOtp.sendVerificationOtp).toHaveBeenCalledTimes(2);
  await enter(host.querySelector('input[aria-label="Code"]'), "222222");
  expect(authClient.signIn.emailOtp).toHaveBeenLastCalledWith({
    email: "ada@example.com",
    otp: "222222",
    name: "Ada",
  });
  // The session refetch moves a signed-in user on; until then the form stays busy.
  expect(clearSpaceSelection).toHaveBeenCalled();
  expect(button("Working…").disabled).toBe(true);
});

it("sends the code on the first Continue but never submits an unfinished code", async () => {
  vi.mocked(fetchAuthCapabilities).mockResolvedValue(codeCapabilities);
  vi.mocked(authClient.emailOtp.sendVerificationOtp).mockResolvedValue({
    data: { success: true },
    error: null,
  } as never);
  await render();
  await enter(host.querySelector('input[name="email"]'), "person@example.com");
  expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
  await submit();
  expect(authClient.emailOtp.sendVerificationOtp).toHaveBeenCalledTimes(1);
  const continueButton = host.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  expect(continueButton.disabled).toBe(true);
  await submit();
  await enter(host.querySelector('input[aria-label="Code"]'), "12345");
  expect(continueButton.disabled).toBe(true);
  await submit();
  expect(authClient.signIn.emailOtp).not.toHaveBeenCalled();
  expect(authClient.emailOtp.sendVerificationOtp).toHaveBeenCalledTimes(1);
});

it("signs in with a typed password and emails a code when it is blank", async () => {
  vi.mocked(fetchAuthCapabilities).mockResolvedValue(codeCapabilities);
  vi.mocked(authClient.signIn.email).mockResolvedValue({ data: {}, error: null } as never);
  await render();
  const password = host.querySelector<HTMLInputElement>('input[type="password"]')!;
  expect(password.required).toBe(false);
  expect(host.querySelector('button[type="submit"]')!.textContent).toBe("Continue");
  expect(host.textContent).not.toContain("Use password");
  await enter(host.querySelector('input[name="email"]'), "person@example.com");
  await enter(password, "example-password");
  expect(host.querySelector('button[type="submit"]')!.textContent).toBe("Sign in");
  await submit();
  expect(authClient.signIn.email).toHaveBeenCalledWith({
    email: "person@example.com",
    password: "example-password",
  });
  expect(authClient.emailOtp.sendVerificationOtp).not.toHaveBeenCalled();
});

it("leaves the password form unchanged without email codes", async () => {
  vi.mocked(fetchAuthCapabilities).mockResolvedValue({ ...codeCapabilities, emailCode: false });
  await render();
  expect(host.querySelector('input[type="password"]')).not.toBeNull();
  expect(host.querySelector<HTMLInputElement>('input[type="password"]')!.required).toBe(true);
  expect(host.querySelector('button[type="submit"]')!.textContent).toBe("Sign in");
});
