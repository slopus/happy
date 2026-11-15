import type { AdapterContext, ComputerRef } from "@rakazo/adapter-kit";
import { SandboxRequestRejectedError } from "@rakazo/adapter-kit";
import * as Logging from "@rakazo/logging";
import { describe, expect, it, vi } from "vitest";
import {
  browserActFromTool,
  browserNavigateFromTool,
  browserResultForModel,
  browserSnapshotFromTool,
  parseBrowserActions,
  redactBrowserResult,
} from "./browser-tools.js";
import { builtinAgentTools } from "./builtin-tools.js";
import { ComputerBrowserProvider } from "./computer-browser.js";
import { redactConnectorPayload } from "./connector-safety.js";
import { FakeBrowserProvider } from "./fake-browser.js";
import { filterPageBrowserTools, PAGE_BROWSER_TOOL_NAMES } from "./run-tool-selection.js";

const context: AdapterContext = {
  operationId: "1",
  traceId: "1",
  spaceId: "w",
  userId: "u",
  signal: new AbortController().signal,
};

const computer: ComputerRef = {
  id: "c1",
  botId: "b1",
  kind: "fake",
  providerRef: "c1",
};

describe("browser tools", () => {
  it("parses click/fill/type actions and rejects bad batches", () => {
    expect(
      parseBrowserActions([
        { kind: "fill", ref: "e1", text: "hi" },
        { kind: "click", ref: "e2" },
      ]),
    ).toEqual([
      { kind: "fill", ref: "e1", text: "hi" },
      { kind: "click", ref: "e2" },
    ]);
    expect(() => parseBrowserActions([])).toThrow(/at least one/i);
    expect(() => parseBrowserActions([{ kind: "click" }])).toThrow(/ref/i);
    expect(() => parseBrowserActions([{ kind: "fill", ref: "e1" }])).toThrow(/text/i);
  });

  it("types over the field's text instead of adding to it", async () => {
    const browser = new FakeBrowserProvider({
      pages: {
        "https://example.test/name": {
          title: "Name",
          html: `<!doctype html><html><head><title>Name</title></head><body>
            <input aria-label="Name" value="Ada" />
          </body></html>`,
        },
      },
    });
    await browserNavigateFromTool(browser, computer, context, { url: "https://example.test/name" });
    type Snap = { elements: Array<{ ref: string; name: string; value?: string }> };
    const name = (result: unknown) => (result as Snap).elements.find((el) => el.name === "Name")!;
    const before = await browserSnapshotFromTool(browser, computer, context, {});
    const typed = await browserActFromTool(browser, computer, context, {
      actions: [{ kind: "type", ref: name(before).ref, text: " Lovelace" }],
    });
    expect(name(typed).value).toBe(" Lovelace");
  });

  it("rejects URL credentials before invoking the browser", async () => {
    const browser = new FakeBrowserProvider();
    browser.navigateError = new Error("must not invoke browser");
    for (const scheme of ["http", "https"]) {
      expect(
        await browserNavigateFromTool(browser, computer, context, {
          url: `${scheme}://example:fake-password@example.test`,
        }),
      ).toMatchObject({ error: expect.stringContaining("credentials") });
    }
  });

  it("sends the page a navigation reached to the model as a snapshot is, with its elements as details", async () => {
    const tree = '[frame https://auth.example.test]\n- textbox "ID number" [f1]';
    const elements = [{ ref: "f1", role: "textbox", name: "ID number" }];
    const browser = new ComputerBrowserProvider({
      liveDriver: async () => ({
        ok: true,
        url: "https://shop.example.test/",
        title: "Shop",
        tree,
        elements,
      }),
    });
    const live: ComputerRef = { id: "c1", botId: "b1", kind: "docker", providerRef: "c1" };
    const navigated = await browserNavigateFromTool(browser, live, context, {
      url: "https://shop.example.test/",
    });
    expect(navigated).toMatchObject({
      url: "https://shop.example.test/",
      title: "Shop",
      tree,
      elements,
    });
    const view = browserResultForModel(navigated) as {
      content: Array<{ text: string }>;
      details: unknown;
    };
    expect(JSON.parse(view.content[0]!.text)).toEqual({
      url: "https://shop.example.test/",
      title: "Shop",
      tree,
    });
    expect(view.details).toBe(navigated);
  });

  it("passes a snapshot's query on to the computer's page browser, trimmed, and leaves it out when blank", async () => {
    const commands: unknown[] = [];
    const browser = new ComputerBrowserProvider({
      liveDriver: async (_computer, request) => {
        commands.push(request);
        return {
          ok: true,
          url: "https://shop.example.test/",
          title: "Shop",
          tree: "",
          elements: [],
        };
      },
    });
    const live: ComputerRef = { id: "c1", botId: "b1", kind: "docker", providerRef: "c1" };
    await browserSnapshotFromTool(browser, live, context, { query: "  postal code " });
    await browserSnapshotFromTool(browser, live, context, { query: "  " });
    await browserSnapshotFromTool(browser, live, context, {});
    expect(commands).toEqual([
      { command: "snapshot", query: "postal code" },
      { command: "snapshot" },
      { command: "snapshot" },
    ]);
  });

  it("sends a navigation that brought no page as it is", async () => {
    const browser = new ComputerBrowserProvider({
      liveDriver: async () => ({ ok: true, url: "https://shop.example.test/", title: "Shop" }),
    });
    const live: ComputerRef = { id: "c1", botId: "b1", kind: "docker", providerRef: "c1" };
    const navigated = await browserNavigateFromTool(browser, live, context, {
      url: "https://shop.example.test/",
    });
    expect(navigated).toEqual({ url: "https://shop.example.test/", title: "Shop" });
    expect(browserResultForModel(navigated)).toBe(navigated);
  });

  it("navigates, snapshots, and acts through the tool helpers", async () => {
    const browser = new FakeBrowserProvider({
      pages: {
        "https://example.test/x": {
          title: "Demo",
          html: `<!doctype html><html><head><title>Demo</title></head><body>
            <input aria-label="Name" />
            <button>Save</button>
          </body></html>`,
        },
      },
    });
    const navigated = await browserNavigateFromTool(browser, computer, context, {
      url: "https://example.test/x",
    });
    expect(navigated).toMatchObject({ title: "Demo" });
    expect("fallback" in navigated && navigated.fallback).toBeFalsy();

    const snap = await browserSnapshotFromTool(browser, computer, context, {});
    expect(snap).toMatchObject({ title: "Demo" });
    expect(String((snap as { tree?: string }).tree)).toMatch(/\[e\d+\]/);

    const nameRef = (snap as { elements: Array<{ ref: string; name: string }> }).elements.find(
      (el) => el.name.includes("Name"),
    )!.ref;
    const acted = await browserActFromTool(browser, computer, context, {
      actions: [{ kind: "fill", ref: nameRef, text: "Ada" }],
    });
    expect(acted).toMatchObject({ ok: true, completed: 1 });
  });

  it("parses upload steps and bounds their file list", () => {
    expect(
      parseBrowserActions([{ kind: "upload", ref: "e3", paths: [" receipts/march.pdf "] }]),
    ).toEqual([{ kind: "upload", ref: "e3", paths: ["receipts/march.pdf"] }]);
    expect(() => parseBrowserActions([{ kind: "upload", ref: "e3" }])).toThrow(/paths/);
    expect(() => parseBrowserActions([{ kind: "upload", ref: "e3", paths: [""] }])).toThrow(
      /paths/,
    );
    expect(() =>
      parseBrowserActions([{ kind: "upload", ref: "e3", paths: Array(11).fill("a.pdf") }]),
    ).toThrow(/at most 10/);
  });

  it.each([undefined, ["bots/b1", "shared"]])(
    "uses only trusted upload roots: %j",
    async (uploadRoots) => {
      const browser = new FakeBrowserProvider();
      const act = vi.spyOn(browser, "act").mockResolvedValue({
        ok: true,
        completed: 2,
        url: "https://example.test",
        title: "Fixture",
      });
      const actions = [
        { kind: "upload", ref: "e1", paths: ["a.txt"], roots: ["bots/b2"] },
        { kind: "upload", ref: "e2", paths: ["shared/b.txt"], roots: ["."] },
      ];
      expect(parseBrowserActions(actions)).toEqual([
        { kind: "upload", ref: "e1", paths: ["a.txt"] },
        { kind: "upload", ref: "e2", paths: ["shared/b.txt"] },
      ]);
      await browserActFromTool(
        browser,
        computer,
        context,
        { actions },
        {
          uploadRoots,
          resolveUploadPath: (path) => (path.startsWith("shared/") ? path : `bots/b1/${path}`),
        },
      );
      expect(act.mock.calls[0]?.[1].actions).toEqual([
        {
          kind: "upload",
          ref: "e1",
          paths: ["bots/b1/a.txt"],
          ...(uploadRoots ? { roots: uploadRoots } : {}),
        },
        {
          kind: "upload",
          ref: "e2",
          paths: ["shared/b.txt"],
          ...(uploadRoots ? { roots: uploadRoots } : {}),
        },
      ]);
    },
  );

  it("uploads workspace files to a hidden file input by ref", async () => {
    const browser = new FakeBrowserProvider({
      pages: {
        "https://example.test/expense": {
          title: "Expense",
          html: `<!doctype html><html><head><title>Expense</title></head><body>
            <label>Receipt <input type="file" role="button" aria-hidden="true" style="display:none" /></label>
            <button>Save</button>
          </body></html>`,
        },
      },
    });
    await browserNavigateFromTool(browser, computer, context, {
      url: "https://example.test/expense",
    });
    const snap = (await browserSnapshotFromTool(browser, computer, context, {})) as {
      elements: Array<{ ref: string; role: string }>;
    };
    const upload = snap.elements.find((el) => el.role === "file upload");
    expect(upload).toBeDefined();

    const resolved: string[] = [];
    const acted = await browserActFromTool(
      browser,
      computer,
      context,
      { actions: [{ kind: "upload", ref: upload!.ref, paths: ["receipts/march.pdf"] }] },
      {
        resolveUploadPath: (path) => {
          resolved.push(path);
          return `bots/b1/${path}`;
        },
      },
    );
    expect(resolved).toEqual(["receipts/march.pdf"]);
    expect(acted).toMatchObject({ ok: true, completed: 1 });
    expect(String((acted as { tree?: string }).tree)).toContain('value="march.pdf"');

    const freshRef = (acted as { elements: Array<{ ref: string; role: string }> }).elements.find(
      (el) => el.role === "file upload",
    )!.ref;
    const refused = await browserActFromTool(browser, computer, context, {
      actions: [{ kind: "upload", ref: freshRef, paths: ["a.pdf", "b.pdf"] }],
    });
    expect(refused).toMatchObject({ ok: false, error: expect.stringContaining("one file") });
  });

  it("parses fill_secret without a value and rejects unknown fields", () => {
    expect(
      parseBrowserActions([
        { kind: "fill_secret", ref: "e1", secret: "site_login", field: "password" },
      ]),
    ).toEqual([{ kind: "fill_secret", ref: "e1", secret: "site_login", field: "password" }]);
    expect(
      parseBrowserActions([
        { kind: "fill_secret", ref: "e1", secret: "site_login", field: " Phone number " },
      ]),
    ).toEqual([{ kind: "fill_secret", ref: "e1", secret: "site_login", field: "Phone number" }]);
    expect(() =>
      parseBrowserActions([{ kind: "fill_secret", ref: "e1", secret: "site_login", field: " " }]),
    ).toThrow("needs field: the label of one of the login's fields");
    expect(() =>
      parseBrowserActions([{ kind: "fill_secret", ref: "e1", field: "password" }]),
    ).toThrow(/secret/);
  });

  describe("saved login fills", () => {
    const loginPage = (url: string) =>
      new FakeBrowserProvider({
        pages: {
          [url]: {
            title: "Sign in",
            html: `<!doctype html><html><head><title>Sign in</title></head><body>
              <input aria-label="Email" />
              <input aria-label="Password" type="password" />
            </body></html>`,
          },
        },
      });
    async function refs(browser: FakeBrowserProvider, url: string) {
      await browserNavigateFromTool(browser, computer, context, { url });
      const snap = (await browserSnapshotFromTool(browser, computer, context, {})) as {
        elements: Array<{ ref: string; name: string }>;
      };
      const ref = (name: string) => snap.elements.find((el) => el.name.includes(name))!.ref;
      return { email: ref("Email"), password: ref("Password") };
    }
    const values = { username: "fake-user@example.test", password: "fake-password-1" };
    const resolveSecretFill = async (step: { field: string }) => ({
      text: values[step.field as keyof typeof values],
      origin: "https://login.example.test",
      hidden: step.field === "password",
    });

    it("types saved values on the saved origin and redacts them from the result", async () => {
      const browser = loginPage("https://login.example.test/signin");
      const { email, password } = await refs(browser, "https://login.example.test/signin");
      const acted = await browserActFromTool(
        browser,
        computer,
        context,
        {
          actions: [
            { kind: "fill_secret", ref: email, secret: "site_login", field: "username" },
            { kind: "fill_secret", ref: password, secret: "site_login", field: "password" },
          ],
        },
        { resolveSecretFill, redactions: () => [values.username, values.password] },
      );
      expect(acted).toMatchObject({ ok: true, completed: 2 });
      expect(JSON.stringify(acted)).not.toContain(values.username);
      expect(JSON.stringify(acted)).not.toContain(values.password);
    });

    it("types the password only into a password field and the username never into one", async () => {
      const browser = loginPage("https://login.example.test/signin");
      for (const [target, field, error] of [
        ["email", "password", /password field/],
        ["password", "username", /text, email, or telephone/],
      ] as const) {
        const ref = (await refs(browser, "https://login.example.test/signin"))[target];
        const acted = await browserActFromTool(
          browser,
          computer,
          context,
          { actions: [{ kind: "fill_secret", ref, secret: "site_login", field }] },
          { resolveSecretFill },
        );
        expect(acted, field).toMatchObject({ ok: false, completed: 0, uncertain: false });
        expect(acted, field).not.toHaveProperty("fallback");
        expect(JSON.stringify(acted), field).toMatch(error);
        expect(JSON.stringify(acted), field).not.toContain(values[field]);
      }
    });

    it("types a hidden field only into a password field and a visible one into a phone field", async () => {
      const url = "https://login.example.test/signin";
      const browser = new FakeBrowserProvider({
        pages: {
          [url]: {
            title: "Sign in",
            html: `<!doctype html><html><head><title>Sign in</title></head><body>
              <input aria-label="ID number" />
              <input aria-label="Phone number" type="tel" />
              <input aria-label="PIN" type="password" />
            </body></html>`,
          },
        },
      });
      await browserNavigateFromTool(browser, computer, context, { url });
      const ref = async (name: string) => {
        const snap = (await browserSnapshotFromTool(browser, computer, context, {})) as {
          elements: Array<{ ref: string; name: string }>;
        };
        return snap.elements.find((el) => el.name.includes(name))!.ref;
      };
      const login = {
        "ID number": { text: "fake-id-123", hidden: false },
        "Phone number": { text: "+1 555 0100", hidden: true },
      };
      const resolveFields = async (step: { field: string }) => ({
        ...login[step.field as keyof typeof login],
        origin: "https://login.example.test",
      });
      const fill = async (target: string, field: string) =>
        browserActFromTool(
          browser,
          computer,
          context,
          {
            actions: [{ kind: "fill_secret", ref: await ref(target), secret: "site_login", field }],
          },
          { resolveSecretFill: resolveFields, redactions: () => ["fake-id-123", "+1 555 0100"] },
        );

      const hiddenInPhone = await fill("Phone number", "Phone number");
      expect(hiddenInPhone).toMatchObject({ ok: false, completed: 0, uncertain: false });
      expect(JSON.stringify(hiddenInPhone)).toMatch(/password field/);
      expect(await fill("PIN", "Phone number")).toMatchObject({ ok: true, completed: 1 });
      expect(await fill("ID number", "ID number")).toMatchObject({ ok: true, completed: 1 });
      const snap = JSON.stringify(await browserSnapshotFromTool(browser, computer, context, {}));
      expect(snap).not.toContain("fake-id-123");
      expect(snap).not.toContain("+1 555 0100");
    });

    it("tells every page browser a hidden field is a password and a visible one a username", async () => {
      const acts: unknown[] = [];
      const recorder = {
        act: async (_computer: unknown, input: { actions: unknown[] }) => {
          acts.push(...input.actions);
          return { ok: true, completed: input.actions.length };
        },
      } as unknown as FakeBrowserProvider;
      for (const hidden of [true, false, undefined]) {
        await browserActFromTool(
          recorder,
          computer,
          context,
          { actions: [{ kind: "fill_secret", ref: "e1", secret: "site_login", field: "Code" }] },
          {
            resolveSecretFill: async () =>
              ({ text: "fake-code", origin: "https://login.example.test", hidden }) as never,
          },
        );
      }
      expect(acts).toEqual(
        ["password", "username", "password"].map((field) => ({
          kind: "fill",
          ref: "e1",
          text: "fake-code",
          origin: "https://login.example.test",
          field,
        })),
      );
    });

    it("never reports a login-filled field's value, even when too short to redact", async () => {
      const browser = loginPage("https://login.example.test/signin");
      const { email } = await refs(browser, "https://login.example.test/signin");
      const shortName = async () => ({
        text: "ada",
        origin: "https://login.example.test",
        hidden: false,
      });
      const acted = await browserActFromTool(
        browser,
        computer,
        context,
        { actions: [{ kind: "fill_secret", ref: email, secret: "site_login", field: "username" }] },
        { resolveSecretFill: shortName },
      );
      expect(acted).toMatchObject({ ok: true });
      expect(JSON.stringify(acted)).not.toContain("ada");
      const snap = await browserSnapshotFromTool(browser, computer, context, {});
      expect(JSON.stringify(snap)).not.toContain("ada");
    });

    it("shows a login-filled field once typing has replaced the login", async () => {
      const browser = loginPage("https://login.example.test/signin");
      const { email } = await refs(browser, "https://login.example.test/signin");
      // Each result carries a fresh snapshot, whose refs replace the previous ones.
      const emailRef = (result: unknown) =>
        (result as { elements: Array<{ ref: string; name: string }> }).elements.find((el) =>
          el.name.includes("Email"),
        )!.ref;
      const filled = await browserActFromTool(
        browser,
        computer,
        context,
        { actions: [{ kind: "fill_secret", ref: email, secret: "site_login", field: "username" }] },
        {
          resolveSecretFill: async () => ({
            text: "ada",
            origin: "https://login.example.test",
            hidden: false,
          }),
        },
      );
      const typed = await browserActFromTool(browser, computer, context, {
        actions: [{ kind: "type", ref: emailRef(filled), text: "!" }],
      });
      expect(typed).toMatchObject({ ok: true });
      expect(JSON.stringify(typed)).not.toContain("ada");
      expect(
        (typed as { elements: Array<{ name: string; value?: string }> }).elements.find((el) =>
          el.name.includes("Email"),
        )?.value,
      ).toBe("!");
    });

    it("refuses to type a saved login into editable page content", async () => {
      const browser = new FakeBrowserProvider({
        pages: {
          "https://login.example.test/notes": {
            title: "Notes",
            html: `<!doctype html><html><head><title>Notes</title></head><body>
              <div contenteditable="true" aria-label="Notes"></div>
            </body></html>`,
          },
        },
      });
      await browserNavigateFromTool(browser, computer, context, {
        url: "https://login.example.test/notes",
      });
      const snap = (await browserSnapshotFromTool(browser, computer, context, {})) as {
        elements: Array<{ ref: string; name: string }>;
      };
      const notes = snap.elements.find((el) => el.name.includes("Notes"))!.ref;
      const acted = await browserActFromTool(
        browser,
        computer,
        context,
        { actions: [{ kind: "fill_secret", ref: notes, secret: "site_login", field: "username" }] },
        { resolveSecretFill },
      );
      expect(acted).toMatchObject({ ok: false, completed: 0 });
      expect(JSON.stringify(acted)).toMatch(/text, email, or telephone/);
    });

    it("refuses to type a saved login into a textarea or a non-login input type", async () => {
      const browser = new FakeBrowserProvider({
        pages: {
          "https://login.example.test/signin": {
            title: "Sign in",
            html: `<!doctype html><html><head><title>Sign in</title></head><body>
              <textarea aria-label="Username"></textarea>
              <input aria-label="Query" type="search" />
              <input aria-label="Website" type="url" />
              <input aria-label="Pin" type="number" />
              <input aria-label="Phone" type="tel" />
            </body></html>`,
          },
        },
      });
      await browserNavigateFromTool(browser, computer, context, {
        url: "https://login.example.test/signin",
      });
      const ref = async (name: string) => {
        const snap = (await browserSnapshotFromTool(browser, computer, context, {})) as {
          elements: Array<{ ref: string; name: string }>;
        };
        return snap.elements.find((el) => el.name.includes(name))!.ref;
      };
      for (const name of ["Username", "Query", "Website", "Pin"]) {
        const acted = await browserActFromTool(
          browser,
          computer,
          context,
          {
            actions: [
              {
                kind: "fill_secret",
                ref: await ref(name),
                secret: "site_login",
                field: "username",
              },
            ],
          },
          { resolveSecretFill },
        );
        expect(acted, name).toMatchObject({ ok: false, completed: 0 });
        expect(JSON.stringify(acted), name).toMatch(/text, email, or telephone/);
      }
      const phone = await browserActFromTool(
        browser,
        computer,
        context,
        {
          actions: [
            {
              kind: "fill_secret",
              ref: await ref("Phone"),
              secret: "site_login",
              field: "username",
            },
          ],
        },
        { resolveSecretFill },
      );
      expect(phone).toMatchObject({ ok: true, completed: 1 });
    });

    it("refuses to type a saved login on a private-LAN HTTP origin", async () => {
      const origin = "http://192.168.2.10:8080";
      const browser = new FakeBrowserProvider({
        pages: {
          [`${origin}/signin`]: {
            title: "Sign in",
            html: `<!doctype html><html><head><title>Sign in</title></head><body>
              <input aria-label="Email" />
            </body></html>`,
          },
        },
      });
      await browserNavigateFromTool(browser, computer, context, { url: `${origin}/signin` });
      const snap = (await browserSnapshotFromTool(browser, computer, context, {})) as {
        elements: Array<{ ref: string; name: string }>;
      };
      const email = snap.elements.find((el) => el.name.includes("Email"))!.ref;
      const acted = await browserActFromTool(
        browser,
        computer,
        context,
        { actions: [{ kind: "fill_secret", ref: email, secret: "site_login", field: "username" }] },
        { resolveSecretFill: async () => ({ text: values.username, origin, hidden: false }) },
      );
      expect(acted).toMatchObject({ ok: false, completed: 0 });
      expect(JSON.stringify(acted)).toMatch(/HTTPS/);
      expect(JSON.stringify(acted)).not.toContain(values.username);
    });

    it("refuses to type a saved login on another origin", async () => {
      const browser = loginPage("https://phish.example.test/signin");
      const { email } = await refs(browser, "https://phish.example.test/signin");
      const acted = await browserActFromTool(
        browser,
        computer,
        context,
        { actions: [{ kind: "fill_secret", ref: email, secret: "site_login", field: "username" }] },
        { resolveSecretFill },
      );
      expect(acted).toMatchObject({ ok: false, completed: 0, uncertain: false });
      expect(acted).toMatchObject({
        error:
          "This login is saved for https://login.example.test; the page is on https://phish.example.test. Open the saved site with browser_navigate, then fill again.",
      });
      // A refusal is settled: nothing points the bot at desktop tools or takeover.
      expect(acted).not.toHaveProperty("fallback");
      expect(acted).not.toHaveProperty("note");
    });

    it("acts on nothing when a saved login cannot be resolved", async () => {
      const browser = loginPage("https://login.example.test/signin");
      const { email, password } = await refs(browser, "https://login.example.test/signin");
      const acted = await browserActFromTool(browser, computer, context, {
        actions: [
          { kind: "fill", ref: email, text: "typed-before" },
          { kind: "fill_secret", ref: password, secret: "site_login", field: "password" },
        ],
      });
      expect(acted).toEqual({
        ok: false,
        completed: 0,
        uncertain: false,
        error: "Saved logins are unavailable here.",
      });
      const snap = await browserSnapshotFromTool(browser, computer, context, {});
      expect(JSON.stringify(snap)).not.toContain("typed-before");
    });
  });

  it("toggles checkboxes via click without undoing activation", async () => {
    const browser = new FakeBrowserProvider({
      pages: {
        "https://example.test/form": {
          title: "Form",
          html: `<!doctype html><html><head><title>Form</title></head><body>
            <label><input type="checkbox" aria-label="Agree" /> Agree</label>
          </body></html>`,
        },
      },
    });
    await browserNavigateFromTool(browser, computer, context, { url: "https://example.test/form" });
    const before = await browserSnapshotFromTool(browser, computer, context, {});
    const agree = (
      before as { elements: Array<{ ref: string; name: string; value?: string }> }
    ).elements.find((el) => el.name.includes("Agree"))!;
    expect(agree.value).toMatch(/unchecked|false|^$/i);
    const acted = await browserActFromTool(browser, computer, context, {
      actions: [{ kind: "click", ref: agree.ref }],
    });
    expect(acted).toMatchObject({ ok: true });
    const after = await browserSnapshotFromTool(browser, computer, context, {});
    const toggled = (after as { elements: Array<{ name: string; value?: string }> }).elements.find(
      (el) => el.name.includes("Agree"),
    )!;
    expect(toggled.value).toMatch(/checked|true/i);
  });

  it("falls back to computer_act for link navigation the in-process page cannot load", async () => {
    const browser = new FakeBrowserProvider({
      pages: {
        "https://example.test/start": {
          title: "Start",
          html: `<!doctype html><html><head><title>Start</title></head><body>
            <a href="https://example.test/next">Next</a>
          </body></html>`,
        },
      },
    });
    await browserNavigateFromTool(browser, computer, context, {
      url: "https://example.test/start",
    });
    const snap = await browserSnapshotFromTool(browser, computer, context, {});
    const link = (snap as { elements: Array<{ ref: string; name: string }> }).elements.find((el) =>
      el.name.includes("Next"),
    )!;
    const acted = await browserActFromTool(browser, computer, context, {
      actions: [{ kind: "click", ref: link.ref }],
    });
    expect(acted).toMatchObject({
      ok: false,
      fallback: "computer_act",
      error: expect.stringMatching(/cannot navigate links|computer_act/i),
    });
  });

  it("surfaces computer_act fallback from the tool layer", async () => {
    const browser = new FakeBrowserProvider();
    browser.forceFallback = "cannot attach to page";
    const result = await browserNavigateFromTool(browser, computer, context, {
      url: "https://example.test",
    });
    expect(result).toMatchObject({
      fallback: "computer_act",
      note: expect.stringMatching(/computer_act/i),
    });
  });

  it("settles an upload path outside the bot's folder before anything runs", async () => {
    const browser = new FakeBrowserProvider();
    const act = vi.spyOn(browser, "act");
    const result = await browserActFromTool(
      browser,
      computer,
      context,
      { actions: [{ kind: "upload", ref: "e1", paths: ["../other-bot/notes.txt"] }] },
      {
        resolveUploadPath: () => {
          throw new Error("Path escapes the bot workspace");
        },
      },
    );
    expect(result).toEqual({
      ok: false,
      completed: 0,
      uncertain: false,
      error: "Path escapes the bot workspace",
    });
    expect(act).not.toHaveBeenCalled();
  });

  it("says only that a saved login failed to load, never what the error quoted", async () => {
    const warn = vi.fn();
    const logger = vi.spyOn(Logging, "getLogger").mockReturnValue({ warn } as never);
    try {
      const browser = new FakeBrowserProvider();
      const act = vi.spyOn(browser, "act");
      const result = await browserActFromTool(
        browser,
        computer,
        context,
        { actions: [{ kind: "fill_secret", ref: "e1", secret: "site_login", field: "password" }] },
        {
          resolveSecretFill: async () => JSON.parse("fake-stored-login-canary"),
        },
      );
      expect(result).toEqual({
        ok: false,
        completed: 0,
        uncertain: false,
        error: "This saved login could not be loaded.",
      });
      expect(JSON.stringify(result)).not.toContain("canary");
      expect(act).not.toHaveBeenCalled();
      expect(JSON.stringify(warn.mock.calls)).not.toContain("canary");
      expect(warn).toHaveBeenCalledWith(expect.any(String), { errorName: "SyntaxError" });
    } finally {
      logger.mockRestore();
    }
  });

  it("lets a cancelled run's saved-login lookup end the call, not pass for a load failure", async () => {
    const controller = new AbortController();
    const browser = new FakeBrowserProvider();
    const pending = browserActFromTool(
      browser,
      computer,
      { ...context, signal: controller.signal },
      { actions: [{ kind: "fill_secret", ref: "e1", secret: "site_login", field: "password" }] },
      {
        resolveSecretFill: async () => {
          controller.abort(new Error("run cancelled"));
          throw new Error("lookup aborted");
        },
      },
    );
    await expect(pending).rejects.toThrow("run cancelled");
  });

  it("keeps a failure while acting uncertain, with the desktop fallback", async () => {
    const browser = new FakeBrowserProvider();
    vi.spyOn(browser, "act").mockRejectedValue(new Error("socket closed"));
    const result = await browserActFromTool(browser, computer, context, {
      actions: [{ kind: "click", ref: "e1" }],
    });
    expect(result).toMatchObject({
      ok: false,
      uncertain: true,
      fallback: "computer_act",
      error: "socket closed",
      note: expect.stringContaining("computer_act"),
    });
  });

  it.each([
    ["ftp://example.test", true],
    ["https://example:fake-password@example.test", true],
    ["not a url", true],
    ["ftp://example.test", false],
  ])(
    "settles a rejected URL before the browser is asked: %s (desktop tools: %s)",
    async (url, desktopTools) => {
      const browser = new FakeBrowserProvider();
      const navigate = vi.spyOn(browser, "navigate");
      const result = await browserNavigateFromTool(
        browser,
        computer,
        context,
        { url },
        { desktopTools },
      );
      // Nothing ran, so there is nothing to look at again and no reason for desktop tools.
      expect(result).toEqual({
        ok: false,
        uncertain: false,
        error: "An HTTP(S) URL without embedded credentials is required",
      });
      expect(navigate).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "a fill_secret without its field",
      [{ kind: "fill_secret", ref: "e1", secret: "site_login" }],
      "browser_act fill_secret needs field: the label of one of the login's fields",
    ],
    [
      "a fill_secret without its login",
      [{ kind: "fill_secret", ref: "e1", field: "password" }],
      "browser_act fill_secret needs secret: the name of a login saved with request_secret",
    ],
    [
      "an unsupported kind",
      [{ kind: "press", ref: "e1" }],
      "browser_act action 0 needs kind: click, fill, type, upload, fill_secret, fill_card, fill_pay_token, fill_code",
    ],
    ["no actions", [], "browser_act requires at least one action"],
    [
      "too many actions",
      Array.from({ length: 25 }, () => ({ kind: "click", ref: "e1" })),
      "browser_act accepts at most 24 actions but got 25; none ran. Send the first 24 or fewer now, then the rest in a separate call.",
    ],
    ["an action without its ref", [{ kind: "click" }], "browser_act action 0 requires ref"],
    ["a fill without its text", [{ kind: "fill", ref: "e1" }], "browser_act fill requires text"],
    [
      "a fill naming a saved login",
      [{ kind: "fill", ref: "e1", secret: "site_login", field: "password" }],
      'browser_act fill requires text; for a saved login use kind "fill_secret"',
    ],
    [
      "a fill naming only a login's field",
      [{ kind: "fill", ref: "e1", field: "username" }],
      'browser_act fill requires text; for a saved login use kind "fill_secret"',
    ],
    [
      "an upload without paths",
      [{ kind: "upload", ref: "e1", paths: [] }],
      "browser_act upload requires paths: one or more file paths",
    ],
    [
      "a bad step after good ones",
      [
        { kind: "click", ref: "e1" },
        { kind: "fill_secret", ref: "e2", secret: "site_login", field: "password" },
        { kind: "fill_secret", ref: "e3", secret: "site_login" },
      ],
      "browser_act fill_secret needs field: the label of one of the login's fields",
    ],
  ])(
    "settles %s before anything runs, without pointing at desktop tools",
    async (_, actions, error) => {
      const browser = new FakeBrowserProvider();
      const act = vi.spyOn(browser, "act");
      const resolveSecretFill = vi.fn();
      for (const desktopTools of [true, false]) {
        const result = await browserActFromTool(
          browser,
          computer,
          context,
          { actions },
          { desktopTools, resolveSecretFill },
        );
        expect(result).toEqual({ ok: false, completed: 0, uncertain: false, error });
      }
      expect(act).not.toHaveBeenCalled();
      expect(resolveSecretFill).not.toHaveBeenCalled();
    },
  );

  it("asks a run without desktop tools to look again instead of pointing at computer_act", async () => {
    const browser = new FakeBrowserProvider();
    browser.forceFallback = "CDP not ready on port 9222";
    const pageOnly = { desktopTools: false };
    const results = [
      await browserNavigateFromTool(
        browser,
        computer,
        context,
        { url: "https://example.test" },
        pageOnly,
      ),
      await browserSnapshotFromTool(browser, computer, context, {}, pageOnly),
      await browserActFromTool(
        browser,
        computer,
        context,
        { actions: [{ kind: "click", ref: "e1" }] },
        pageOnly,
      ),
    ];
    vi.spyOn(browser, "snapshot").mockRejectedValueOnce(new Error("socket closed"));
    results.push(await browserSnapshotFromTool(browser, computer, context, {}, pageOnly));
    for (const result of results) {
      expect(result).toMatchObject({
        error: expect.any(String),
        note: expect.stringContaining("may still be starting, so call browser_snapshot again"),
      });
      expect(result).not.toHaveProperty("fallback");
      expect(JSON.stringify(result)).not.toContain("computer_act");
    }
    // A run that has the desktop tools keeps its fallback.
    expect(
      await browserSnapshotFromTool(browser, computer, context, {}, { desktopTools: true }),
    ).toMatchObject({ fallback: "computer_act", note: expect.stringContaining("computer_act") });
  });

  it("keeps the page tools' descriptions short", () => {
    const length = (name: string) =>
      builtinAgentTools.find((tool) => tool.name === name)?.description.length ?? Infinity;
    expect(length("browser_act")).toBeLessThanOrEqual(1450);
    expect(length("browser_navigate")).toBeLessThanOrEqual(300);
  });

  it("points a dialog the page left open at the tools that can answer it", async () => {
    const live = {
      ok: true,
      url: "https://example.test/",
      title: "Example",
      tree: "",
      elements: [],
    };
    const opened = {
      ok: false,
      completed: 1,
      uncertain: false,
      error: 'A confirm dialog is open on the screen: "Delete this?"',
      dialog: "confirm",
      fallback: "computer_act" as const,
    };
    const liveDriver = vi
      .fn()
      .mockResolvedValueOnce({
        ...live,
        completed: 1,
        note: 'The page showed an alert, now closed: "Saved".',
      })
      .mockResolvedValue(opened);
    const browser = new ComputerBrowserProvider({ liveDriver });
    const liveComputer: ComputerRef = { ...computer, kind: "docker" };
    const click = { actions: [{ kind: "click", ref: "e1" }] };
    expect(await browserActFromTool(browser, liveComputer, context, click)).toMatchObject({
      ok: true,
      note: 'The page showed an alert, now closed: "Saved".',
    });
    expect(
      await browserActFromTool(browser, liveComputer, context, click, { desktopTools: true }),
    ).toMatchObject({
      completed: 1,
      error: opened.error,
      fallback: "computer_act",
      note: expect.stringMatching(/^Answer it with computer_act/),
    });
    const pageOnly = await browserSnapshotFromTool(
      browser,
      liveComputer,
      context,
      {},
      { desktopTools: false },
    );
    expect(pageOnly).toMatchObject({
      error: opened.error,
      note: expect.stringMatching(/^Use request_takeover/),
    });
    expect(JSON.stringify(pageOnly)).not.toContain("computer_act");
  });

  it("hides page browser tools when the computer is not graphical", () => {
    const tools = [...PAGE_BROWSER_TOOL_NAMES].map((name) => ({ name }));
    expect(filterPageBrowserTools(tools, true)).toHaveLength(3);
    expect(filterPageBrowserTools(tools, false)).toEqual([]);
    expect(filterPageBrowserTools([{ name: "computer_act" }, ...tools], false)).toEqual([
      { name: "computer_act" },
    ]);
  });
});

describe("browser tools and purchase approval", () => {
  const click = (ref: string) => ({ kind: "click", ref });
  const actWith = async (args: Record<string, unknown>, approvedPurchase?: unknown) => {
    const seen: unknown[][] = [];
    const browser = new FakeBrowserProvider();
    browser.act = async (_computer, request) => {
      seen.push(request.actions);
      return { ok: true, completed: request.actions.length, url: "", title: "" };
    };
    await browserActFromTool(browser, computer, context, args, {
      approvedPurchase: approvedPurchase as never,
    });
    return seen[0];
  };

  it("never takes an approval from the model's own steps", async () => {
    const given = { kind: "click", ref: "e1", approved: true, site: "shop.example.test" };
    expect(parseBrowserActions([given])).toEqual([{ kind: "click", ref: "e1" }]);
    expect(
      await actWith({ actions: [given], purchaseApproval: { steps: [0], site: "x.test" } }),
    ).toEqual([{ kind: "click", ref: "e1" }]);
  });

  it("marks only the clicks the user approved, for the site they approved", async () => {
    const approval = { steps: [2], site: "shop.example.test", label: "Pay $5", amount: "$5" };
    expect(
      await actWith(
        {
          actions: [click("e1"), { kind: "fill", ref: "e2", text: "x" }, click("e3"), click("e4")],
        },
        approval,
      ),
    ).toEqual([
      { kind: "click", ref: "e1" },
      { kind: "fill", ref: "e2", text: "x" },
      {
        kind: "click",
        ref: "e3",
        approved: true,
        site: "shop.example.test",
        label: "Pay $5",
        amount: "$5",
        total: "",
      },
      { kind: "click", ref: "e4" },
    ]);
    expect(await actWith({ actions: [{ kind: "fill", ref: "e2", text: "x" }] }, approval)).toEqual([
      { kind: "fill", ref: "e2", text: "x" },
    ]);
  });
  it("lets a card for a page that could not be checked cover each click, bound to no site", async () => {
    const unchecked = { steps: [], site: "", label: "", amount: "" };
    const marked = { approved: true, site: "", label: "", amount: "", total: "" };
    expect(
      await actWith(
        { actions: [click("e1"), { kind: "fill", ref: "e2", text: "x" }, click("e3")] },
        unchecked,
      ),
    ).toEqual([
      { kind: "click", ref: "e1", ...marked },
      { kind: "fill", ref: "e2", text: "x" },
      { kind: "click", ref: "e3", ...marked },
    ]);
  });
});

describe("browser tools on dropdowns and stale refs", () => {
  const html = `<!doctype html><html><head><title>Returns</title></head><body>
    <select aria-label="Year"><option value="">Choose</option>
      <option value="p23">שנת 2023</option><option value="p24" selected>שנת 2024</option></select>
  </body></html>`;
  const fake = async () => {
    const browser = new FakeBrowserProvider({
      pages: { "https://example.test/r": { title: "Returns", html } },
    });
    await browserNavigateFromTool(browser, computer, context, { url: "https://example.test/r" });
    type Snap = { tree: string; elements: Array<{ ref: string; name: string; value?: string }> };
    const snap = (await browserSnapshotFromTool(browser, computer, context, {})) as Snap;
    return { browser, snap, year: snap.elements.find((el) => el.name === "Year")! };
  };

  it("lists a dropdown's options in the snapshot", async () => {
    const { snap, year } = await fake();
    expect(snap.tree).toContain(
      'options: "Choose"="", "שנת 2023"="p23", "שנת 2024"="p24" (selected)',
    );
    expect(year).toMatchObject({
      options: [
        { label: "Choose", value: "" },
        { label: "שנת 2023", value: "p23" },
        { label: "שנת 2024", value: "p24", selected: true },
      ],
    });
  });

  it("fills a dropdown by an option's visible label", async () => {
    const { browser, year } = await fake();
    const acted = (await browserActFromTool(browser, computer, context, {
      actions: [{ kind: "fill", ref: year.ref, text: "שנת 2023" }],
    })) as { ok: boolean; elements: Array<{ name: string; value?: string }> };
    expect(acted.ok).toBe(true);
    expect(acted.elements.find((el) => el.name === "Year")?.value).toBe("p23");
  });

  it("settles an option the dropdown does not have, with its options and the page", async () => {
    const { browser, year } = await fake();
    const acted = await browserActFromTool(browser, computer, context, {
      actions: [{ kind: "fill", ref: year.ref, text: "2019" }],
    });
    expect(acted).toMatchObject({
      ok: false,
      uncertain: false,
      error: expect.stringContaining(
        'no option "2019". Its options: "Choose"="", "שנת 2023"="p23"',
      ),
      tree: expect.stringContaining("Year"),
    });
    expect(acted).not.toHaveProperty("fallback");
    expect(acted).not.toHaveProperty("note");
  });

  it("replaces the old choice of a multiple select, and refuses an option in a disabled group", async () => {
    const page = `<!doctype html><html><head><title>Tags</title></head><body>
      <select aria-label="Tags" multiple><option selected>A</option><option selected>B</option><option>C</option>
        <optgroup label="Soon" disabled><option>D</option></optgroup></select></body></html>`;
    const browser = new FakeBrowserProvider({
      pages: { "https://example.test/t": { title: "Tags", html: page } },
    });
    await browserNavigateFromTool(browser, computer, context, { url: "https://example.test/t" });
    type Snap = {
      elements: Array<{
        ref: string;
        name: string;
        value?: string;
        options?: Array<{ label: string; selected?: boolean; disabled?: boolean }>;
      }>;
    };
    const tags = ((await browserSnapshotFromTool(browser, computer, context, {})) as Snap)
      .elements[0]!;
    expect(tags.options?.at(-1)).toMatchObject({ label: "D", disabled: true });
    const acted = (await browserActFromTool(browser, computer, context, {
      actions: [{ kind: "fill", ref: tags.ref, text: "C" }],
    })) as Snap & { ok: boolean };
    expect(acted.ok).toBe(true);
    expect(acted.elements[0]!.options?.filter((o) => o.selected).map((o) => o.label)).toEqual([
      "C",
    ]);
    const refused = await browserActFromTool(browser, computer, context, {
      actions: [{ kind: "fill", ref: acted.elements[0]!.ref, text: "D" }],
    });
    expect(refused).toMatchObject({
      ok: false,
      uncertain: false,
      error: expect.stringContaining('The option "D" is disabled'),
    });
    expect(refused).not.toHaveProperty("fallback");
  });

  it("hides a secret with a quote and a backslash where a snapshot quotes it, in a name and in a value", async () => {
    const secret = 'zq"xv\\mk';
    const html = `<!doctype html><html><head><title>Echo</title></head><body>
      <button aria-label='${secret}'>Echo</button><input aria-label="Field" /></body></html>`;
    const browser = new FakeBrowserProvider({
      pages: { "https://example.test/e": { title: "Echo", html } },
    });
    await browserNavigateFromTool(browser, computer, context, { url: "https://example.test/e" });
    type Snap = { elements: Array<{ ref: string; name: string }> };
    const field = (
      (await browserSnapshotFromTool(browser, computer, context, {})) as Snap
    ).elements.find((el) => el.name === "Field")!;
    const fill = { actions: [{ kind: "fill", ref: field.ref, text: secret }] };
    const acted = await browserActFromTool(browser, computer, context, fill, {
      redactions: () => [secret],
    });
    // The tree quotes names and values, so the secret reads differently there.
    const quoted = JSON.stringify(secret).slice(1, -1);
    const tree = String((acted as { tree: string }).tree);
    expect(tree).toContain("[redacted]");
    expect(tree).not.toContain(quoted);
    expect(tree).not.toContain("xv");
    expect(JSON.stringify(acted)).not.toContain("xv");
    // With the plain secret alone, the quoted form would have been left in the tree.
    const snapshot = (await browserSnapshotFromTool(browser, computer, context, {})) as {
      tree: string;
    };
    expect((redactConnectorPayload(snapshot, [secret]) as typeof snapshot).tree).toBe(
      snapshot.tree,
    );
    expect(snapshot.tree).toContain(quoted);
    expect((redactBrowserResult(snapshot, [secret]) as typeof snapshot).tree).not.toContain("xv");
  });

  it("settles a stale ref with a fresh page instead of sending the bot to the desktop", async () => {
    const { browser } = await fake();
    const acted = await browserActFromTool(browser, computer, context, {
      actions: [{ kind: "click", ref: "e999" }],
    });
    expect(acted).toMatchObject({
      ok: false,
      uncertain: false,
      error: expect.stringContaining("Stale element ref"),
    });
    expect(acted).not.toHaveProperty("fallback");
    expect(acted).not.toHaveProperty("note");
    expect(acted).toHaveProperty("tree", expect.stringContaining("Year"));
  });

  it("passes a settled step error from the live helper on without the desktop note", async () => {
    const provider = new ComputerBrowserProvider({
      liveDriver: async () => ({
        ok: false,
        completed: 0,
        uncertain: false,
        url: "https://example.test/r",
        title: "Returns",
        tree: '- combobox "Year" [e5] options: "2023", "2024"',
        elements: [{ ref: "e5", role: "combobox", name: "Year" }],
        error: 'This dropdown has no option "2019". Its options: "2023", "2024".',
      }),
    });
    const live: ComputerRef = { id: "c", botId: "b", kind: "docker", providerRef: "c" };
    const acted = await browserActFromTool(provider, live, context, {
      actions: [{ kind: "fill", ref: "e5", text: "2019" }],
    });
    expect(acted).toMatchObject({
      ok: false,
      uncertain: false,
      tree: expect.stringContaining("e5"),
    });
    expect(acted).not.toHaveProperty("fallback");
    expect(acted).not.toHaveProperty("note");
  });
});

describe("browser_act fill_code", () => {
  const origin = "https://login.example.test";

  it("parses a ref and nothing the model could put a code in", () => {
    expect(parseBrowserActions([{ kind: "fill_code", ref: "e1", text: "123456" }])).toEqual([
      { kind: "fill_code", ref: "e1" },
    ]);
    expect(() => parseBrowserActions([{ kind: "fill_code" }])).toThrow(/requires ref/);
  });

  function held(overrides: { claim?: () => Promise<string | undefined> } = {}) {
    return {
      text: "123456",
      origin,
      claim: overrides.claim ?? vi.fn(async () => undefined),
      restore: vi.fn(async () => undefined),
    };
  }

  async function fillCode(options: { completed: number; code?: ReturnType<typeof held> }) {
    const browser = new FakeBrowserProvider();
    const act = vi.spyOn(browser, "act").mockResolvedValue({
      ok: options.completed > 0,
      completed: options.completed,
      uncertain: false,
      url: `${origin}/verify`,
      title: "Code 123456",
      tree: "input value=123456",
    });
    const code = options.code ?? held();
    const result = await browserActFromTool(
      browser,
      computer,
      context,
      { actions: [{ kind: "fill_code", ref: "e1" }] },
      { resolveCodeFill: async () => code, redactions: () => ["123456"] },
    );
    return { act, result, code };
  }

  it("types the code into a code box bound to its site, and hides it from the result", async () => {
    const { act, result, code } = await fillCode({ completed: 1 });
    expect(act.mock.calls[0]?.[1].actions).toEqual([
      { kind: "fill", ref: "e1", text: "123456", origin, field: "code" },
    ]);
    expect(code.claim).toHaveBeenCalledOnce();
    expect(code.restore).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("123456");
  });

  it("gives the code back when the page took nothing, so it can be tried on the right page", async () => {
    const { code } = await fillCode({ completed: 0 });
    expect(code.claim).toHaveBeenCalledOnce();
    expect(code.restore).toHaveBeenCalledOnce();
  });

  it("keeps a code spent when the page did not clearly refuse it", async () => {
    for (const refusal of [{ uncertain: true }, {}]) {
      const browser = new FakeBrowserProvider();
      vi.spyOn(browser, "act").mockResolvedValue({
        ok: false,
        completed: 0,
        url: `${origin}/verify`,
        title: "Verify",
        error: "socket closed",
        ...refusal,
      });
      const code = held();
      await browserActFromTool(
        browser,
        computer,
        context,
        { actions: [{ kind: "fill_code", ref: "e1" }] },
        { resolveCodeFill: async () => code },
      );
      expect(code.claim).toHaveBeenCalledOnce();
      expect(code.restore).not.toHaveBeenCalled();
    }
  });

  it("keeps a code spent when the call failed with an unknown outcome", async () => {
    const browser = new FakeBrowserProvider();
    vi.spyOn(browser, "act").mockRejectedValue(new Error("socket closed"));
    const code = held();
    await browserActFromTool(
      browser,
      computer,
      context,
      { actions: [{ kind: "fill_code", ref: "e1" }] },
      { resolveCodeFill: async () => code },
    );
    expect(code.claim).toHaveBeenCalledOnce();
    expect(code.restore).not.toHaveBeenCalled();
  });

  it("does not fail the fill when a refused code cannot be given back", async () => {
    const warn = vi.fn();
    const logger = vi.spyOn(Logging, "getLogger").mockReturnValue({ warn } as never);
    try {
      const code = held();
      code.restore.mockRejectedValue(new Error("database down: 123456"));
      const { result } = await fillCode({ completed: 0, code });
      expect(result).toMatchObject({ ok: false });
      expect(JSON.stringify(warn.mock.calls)).not.toContain("123456");
    } finally {
      logger.mockRestore();
    }
  });

  describe("when the computer's page browser fails to take the step", () => {
    const dockerComputer: ComputerRef = {
      id: "c2",
      botId: "b1",
      kind: "docker",
      providerRef: "c2",
    };

    async function fillThrough(failure: Error) {
      const browser = new ComputerBrowserProvider({
        liveDriver: async () => {
          throw failure;
        },
      });
      const code = held();
      const result = await browserActFromTool(
        browser,
        dockerComputer,
        context,
        { actions: [{ kind: "fill_code", ref: "e1" }] },
        { resolveCodeFill: async () => code },
      );
      return { code, result };
    }

    it("gives the code back when the supervisor refused the request before running anything", async () => {
      const { code, result } = await fillThrough(new SandboxRequestRejectedError());
      expect(code.claim).toHaveBeenCalledOnce();
      expect(code.restore).toHaveBeenCalledOnce();
      expect(result).toMatchObject({ ok: false, uncertain: false, completed: 0 });
    });

    it.each([
      ["a failed request", new Error("page browser failed: 500")],
      ["another refusal", new Error("page browser failed: 400")],
      ["a transport error", new TypeError("fetch failed")],
      ["a timeout", new Error("Page browser timed out; the page may be busy")],
    ])("keeps the code spent after %s", async (_name, failure) => {
      const { code, result } = await fillThrough(failure);
      expect(code.claim).toHaveBeenCalledOnce();
      expect(code.restore).not.toHaveBeenCalled();
      expect(result).toMatchObject({ ok: false, uncertain: true });
    });
  });

  it("refuses a second fill_code in the same batch, before the page is asked", async () => {
    const browser = new FakeBrowserProvider();
    const act = vi.spyOn(browser, "act");
    const code = held();
    const result = await browserActFromTool(
      browser,
      computer,
      context,
      {
        actions: [
          { kind: "fill_code", ref: "e1" },
          { kind: "fill_code", ref: "e2" },
        ],
      },
      { resolveCodeFill: async () => code },
    );
    expect(result).toEqual({
      ok: false,
      completed: 0,
      uncertain: false,
      error: "browser_act takes one fill_code at a time",
    });
    expect(code.claim).not.toHaveBeenCalled();
    expect(act).not.toHaveBeenCalled();
  });

  it("refuses when another fill took the code first, before the page is asked", async () => {
    const browser = new FakeBrowserProvider();
    const act = vi.spyOn(browser, "act");
    const result = await browserActFromTool(
      browser,
      computer,
      context,
      { actions: [{ kind: "fill_code", ref: "e1" }] },
      {
        resolveCodeFill: async () =>
          held({ claim: async () => "No code is waiting. Use request_secret with oneTimeCode." }),
      },
    );
    expect(result).toMatchObject({
      ok: false,
      completed: 0,
      error: expect.stringContaining("No code"),
    });
    expect(act).not.toHaveBeenCalled();
  });

  it("releases an approved purchase when its code is refused or can't be taken", async () => {
    const browser = new FakeBrowserProvider();
    const act = vi.spyOn(browser, "act");
    const releasePurchase = vi.fn(async () => {});
    const claims = [
      async () => "No code is waiting.",
      async () => {
        throw new Error("The login could not be read.");
      },
    ];
    for (const claim of claims) {
      const result = await browserActFromTool(
        browser,
        computer,
        context,
        {
          actions: [
            { kind: "fill_code", ref: "e1" },
            { kind: "click", ref: "e2" },
          ],
        },
        {
          resolveCodeFill: async () => held({ claim }),
          approvedPurchase: {
            steps: [1],
            site: "shop.example.test",
            label: "Pay $5",
            amount: "$5",
            amountSource: "button",
          },
          countPurchase: async () => undefined,
          releasePurchase,
        },
      );
      expect(result).toMatchObject({ ok: false });
    }
    expect(releasePurchase).toHaveBeenCalledTimes(2);
    expect(act).not.toHaveBeenCalled();
  });

  it("settles a missing code before the page is touched, without echoing a lookup failure", async () => {
    const browser = new FakeBrowserProvider();
    const act = vi.spyOn(browser, "act");
    const noCode = await browserActFromTool(
      browser,
      computer,
      context,
      { actions: [{ kind: "fill_code", ref: "e1" }] },
      { resolveCodeFill: async () => ({ error: "No code is waiting." }) },
    );
    expect(noCode).toEqual({
      ok: false,
      completed: 0,
      uncertain: false,
      error: "No code is waiting.",
    });
    const broken = await browserActFromTool(
      browser,
      computer,
      context,
      { actions: [{ kind: "fill_code", ref: "e1" }] },
      {
        resolveCodeFill: async () => {
          throw new Error("canary-123456");
        },
      },
    );
    expect(broken).toEqual({
      ok: false,
      completed: 0,
      uncertain: false,
      error: "This code could not be loaded.",
    });
    expect(JSON.stringify(broken)).not.toContain("canary");
    expect(act).not.toHaveBeenCalled();
  });
});
