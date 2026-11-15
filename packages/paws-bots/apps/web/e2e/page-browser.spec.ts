import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { chromium, expect, test } from "@playwright/test";

const execute = promisify(execFile);
const helper = path.resolve(
  import.meta.dirname,
  "../../../infra/sandboxes/computer/rakazo-page-browser",
);

// The helper drives Chromium through agent-browser; CI installs the pinned binary and sets this.
test.skip(
  !process.env.CI && !process.env.RAKAZO_AGENT_BROWSER,
  "set RAKAZO_AGENT_BROWSER (infra/sandboxes/computer/install-chrome-use.sh)",
);

// The helper reads the tab the person sees through Chromium's target list, which only the full
// browser orders by the front tab; the headless shell Playwright picks for headless: true does not.
const BROWSER: { channel: "chromium"; headless: true } = { channel: "chromium", headless: true };

test("live page helper preserves identity, masks passwords, and reports partial actions", async () => {
  const profile = await mkdtemp(path.join(os.tmpdir(), "page-browser-test-"));
  const server = http.createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(`<!doctype html><title>Fixture</title><p>Readable article content</p>
      <label>Name <input id="name"></label><input aria-label="Password" type="password" value="fake-test-password">
      <button id="save" onclick="this.dataset.clicks=Number(this.dataset.clicks||0)+1">Save</button>
      <label><input type="checkbox">Agree</label><button disabled>Disabled</button>
      <script>window.__rakazoPageBrowser={snapshot:()=>({title:'spoofed'})};</script>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture server");
  let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
  try {
    context = await chromium.launchPersistentContext(profile, {
      ...BROWSER,
      args: ["--remote-debugging-port=0"],
    });
    let port = "";
    await expect(async () => {
      port = (await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]!;
      expect(port).toMatch(/^\d+$/);
    }).toPass({ timeout: 5_000 });
    async function command(name: string, args: Record<string, unknown> = {}) {
      const { stdout } = await execute("python3", [helper, name, JSON.stringify(args)], {
        env: { ...process.env, RAKAZO_CDP_PORT: port },
        timeout: 30_000,
      });
      return JSON.parse(stdout);
    }
    const page = context.pages()[0]!;
    await page.goto(`http://127.0.0.1:${address.port}`);
    const snapshot = await command("snapshot");
    expect(snapshot.ok).toBe(true);
    expect(snapshot.title).toBe("Fixture");
    expect(snapshot.tree).toContain("Readable article content");
    expect(JSON.stringify(snapshot)).not.toContain("fake-test-password");
    const ref = (snapshot: { elements: { name: string; ref: string }[] }, name: string) =>
      snapshot.elements.find((element) => element.name === name)!.ref;
    const result = await command("act", {
      actions: [
        { kind: "fill", ref: ref(snapshot, "Name"), text: "Example" },
        { kind: "click", ref: ref(snapshot, "Save") },
        { kind: "click", ref: "e999999999" },
      ],
    });
    expect(result).toMatchObject({ ok: false, completed: 2, uncertain: false });
    await expect(page.locator("#name")).toHaveValue("Example");
    await expect(page.locator("#save")).toHaveAttribute("data-clicks", "1");

    const stale = await command("snapshot");
    await page.locator("#save").evaluate((el) => {
      el.outerHTML = '<button id="save">Replacement</button>';
    });
    expect(
      await command("act", { actions: [{ kind: "click", ref: ref(stale, "Save") }] }),
    ).toMatchObject({ ok: false, completed: 0 });
    const refreshed = await command("snapshot");
    expect(ref(refreshed, "Replacement")).not.toBe(ref(stale, "Save"));
    expect(
      await command("act", { actions: [{ kind: "click", ref: ref(refreshed, "Agree") }] }),
    ).toMatchObject({ ok: true, completed: 1 });
    await expect(page.getByRole("checkbox")).toBeChecked();
    expect(
      await command("navigate", { url: `http://127.0.0.1:${address.port}/next` }),
    ).toMatchObject({ ok: true, title: "Fixture" });
    expect(
      await command("act", { actions: [{ kind: "click", ref: ref(refreshed, "Replacement") }] }),
    ).toMatchObject({ ok: false, completed: 0 });
    expect(await command("navigate", { url: "file:///tmp/fixture" })).toMatchObject({ ok: false });
    await page.route("http://insecure.test/", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<title>Insecure fixture</title><button>HTTP action</button>",
      }),
    );
    await page.goto("http://insecure.test/");
    expect(await page.evaluate(() => window.isSecureContext)).toBe(false);
    expect(await command("snapshot")).toMatchObject({ ok: true, title: "Insecure fixture" });

    // Saved passwords go only into password fields. A site can still reveal them normally.
    await page.route("https://login.example.test/", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<title>Sign in</title><input aria-label="Email">
          <input id="password" aria-label="Password" type="password">
          <button onclick="const field = document.getElementById('password'); field.type = 'text';
            requestAnimationFrame(() => { window.drawn = field.value; })">Show</button>`,
      }),
    );
    await page.goto("https://login.example.test/");
    const login = {
      text: "fake-test-password",
      origin: "https://login.example.test",
      field: "password",
    };
    const signIn = await command("snapshot");
    const refused = await command("act", {
      actions: [{ kind: "fill", ref: ref(signIn, "Email"), ...login }],
    });
    expect(refused).toEqual({
      ok: false,
      completed: 0,
      uncertain: false,
      error: "A saved password can only be typed into a password field.",
    });
    await expect(page.getByLabel("Email")).toHaveValue("");
    const filled = await command("act", {
      actions: [
        {
          kind: "fill",
          ref: ref(await command("snapshot"), "Password"),
          ...login,
        },
      ],
    });
    expect(filled).toMatchObject({ ok: true, completed: 1 });
    await expect(page.locator("#password")).toHaveValue(login.text);
    const shown = await command("act", {
      actions: [{ kind: "click", ref: ref(filled, "Show") }],
    });
    expect(shown).toMatchObject({ ok: true, completed: 1 });
    await expect
      .poll(() => page.evaluate(() => (window as { drawn?: string }).drawn))
      .toBe(login.text);
    await expect(page.locator("#password")).toHaveAttribute("type", "text");
    await expect(page.locator("#password")).toHaveValue(login.text);
    expect(JSON.stringify([refused, filled, shown])).not.toContain(login.text);
    await page.goto(`http://127.0.0.1:${address.port}`);
    const elsewhere = await command("act", {
      actions: [{ kind: "fill", ref: ref(await command("snapshot"), "Name"), ...login }],
    });
    expect(elsewhere).toMatchObject({ ok: false, completed: 0, uncertain: false });
    expect(elsewhere.error).toMatch(
      /^Website logins can only be filled on HTTPS\. Open the saved site/,
    );
    expect(elsewhere).not.toHaveProperty("fallback");
    await page.goto(`http://127.0.0.1:${address.port}`);
    const other = await context.newPage();
    await other.setContent("<title>Other tab</title><button>Other action</button>");
    await page.bringToFront();
    // The page tools read the tab last brought to the front, which is the one on screen.
    expect(await command("snapshot")).toMatchObject({ ok: true, title: "Fixture" });
    await expect(page).toHaveTitle("Fixture");
    await expect(other).toHaveTitle("Other tab");
    // Reading an existing page neither creates nor switches tabs.
    expect(context.pages()).toHaveLength(2);
  } finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("live page helper waits for a site's sign-in check, or says the page is still loading", async () => {
  const profile = await mkdtemp(path.join(os.tmpdir(), "page-browser-settle-"));
  // Like many web apps, the page draws a signed-out shell and asks its server who is signed in.
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fixture.test");
    if (url.pathname === "/api/me") {
      setTimeout(
        () => {
          res.setHeader("content-type", "application/json");
          res.end('{"name":"test-user"}');
        },
        Number(url.searchParams.get("delay")),
      );
      return;
    }
    res.setHeader("content-type", "text/html");
    res.end(`<!doctype html><title>Example</title><header><a href="/login">Sign in</a></header>
      <main id="m">Loading</main>
      <script>fetch('/api/me?delay=${Number(url.searchParams.get("check"))}').then((r) => r.json())
        .then((u) => { document.querySelector('header').textContent = 'Signed in as ' + u.name;
          document.getElementById('m').textContent = 'Your account'; });</script>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture server");
  let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
  try {
    context = await chromium.launchPersistentContext(profile, {
      ...BROWSER,
      args: ["--remote-debugging-port=0"],
    });
    let port = "";
    await expect(async () => {
      port = (await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]!;
      expect(port).toMatch(/^\d+$/);
    }).toPass({ timeout: 5_000 });
    const snapshot = async () => {
      const { stdout } = await execute("python3", [helper, "snapshot", "{}"], {
        env: { ...process.env, RAKAZO_CDP_PORT: port },
        timeout: 30_000,
      });
      return JSON.parse(stdout);
    };
    const page = context.pages()[0]!;

    // The check answers within the wait: the snapshot shows the signed-in page. The helper first
    // reads it after it began loading, as when the person opened it.
    await page.goto(`http://127.0.0.1:${address.port}/?check=500`);
    const settled = await snapshot();
    expect(settled).toMatchObject({ ok: true, title: "Example" });
    expect(settled.tree).toContain("Signed in as test-user");
    expect(settled.tree).not.toContain('link "Sign in"');
    expect(settled).not.toHaveProperty("loading");

    // The check outlasts the wait: the snapshot still shows the shell, and says it is loading.
    await page.goto(`http://127.0.0.1:${address.port}/?check=20000`);
    const loading = await snapshot();
    expect(loading).toMatchObject({ ok: true, title: "Example", loading: true });
    expect(loading.tree).toContain('link "Sign in"');
  } finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("live page helper reads a checkout's order lines for the pay approval", async () => {
  const profile = await mkdtemp(path.join(os.tmpdir(), "page-browser-order-"));
  const server = http.createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(`<!doctype html><meta charset="utf-8"><title>Checkout</title>
      <style>.row { display: flex; justify-content: space-between } aside { width: 320px }</style>
      <header><a href="/cart">Cart · Socks $9.00</a></header>
      <main>
        <h1>Checkout</h1>
        <label><input type="radio" name="ship" checked> Standard delivery $6.00</label>
        <aside>
          <h2>Order summary</h2>
          <div class="row"><span>Bananas × 6</span><span>$3.00</span></div>
          <div class="row"><span>Oat milk 1L <small>× 2</small></span><span>$8.40</span></div>
          <div class="row" style="display: none"><span>Hidden gift</span><span>$1.00</span></div>
          <div style="opacity: 0"><div class="row"><span>Faded gift</span><span>$2.00</span></div></div>
          <div class="row" style="color: transparent"><span>Ink-free gift</span><span>$4.00</span></div>
          <div class="row"><span>Subtotal</span><span>$11.40</span></div>
          <div class="row"><span>Delivery</span><span>$6.00</span></div>
          <div class="row"><strong>Total</strong><strong>$17.40</strong></div>
        </aside>
        <button>Place order</button>
        <p>Recommended: Grapes 500g $4.00</p>
      </main>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture server");
  let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
  try {
    context = await chromium.launchPersistentContext(profile, {
      ...BROWSER,
      args: ["--remote-debugging-port=0"],
    });
    let port = "";
    await expect(async () => {
      port = (await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]!;
      expect(port).toMatch(/^\d+$/);
    }).toPass({ timeout: 5_000 });
    const page = context.pages()[0]!;
    await page.goto(`http://127.0.0.1:${address.port}/checkout`);
    // Enter on the screen asks the page what it shows: its final step, total and order lines.
    const { stdout } = await execute(
      "python3",
      [helper, "purchase_check", JSON.stringify({ desktop: true, enter: true })],
      { env: { ...process.env, RAKAZO_CDP_PORT: port }, timeout: 30_000 },
    );
    expect(JSON.parse(stdout)).toMatchObject({
      ok: true,
      purchase: {
        label: "Place order",
        amount: "$17.40",
        items: [
          { name: "Bananas × 6", amount: "$3.00" },
          { name: "Oat milk 1L × 2", amount: "$8.40" },
          { name: "Delivery", amount: "$6.00" },
        ],
      },
    });
  } finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("live page helper reaches a form past the control limit by query or by scrolling to it", async () => {
  const profile = await mkdtemp(path.join(os.tmpdir(), "page-browser-long-"));
  const stories = Array.from(
    { length: 200 },
    (_, n) =>
      `<article><h2>Story ${n}</h2><p>Story ${n} text.</p><a href="#s${n}">Read story ${n}</a></article>`,
  ).join("");
  const server = http.createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(`<!doctype html><title>Archive</title>${stories}
      <form onsubmit="event.preventDefault(); window.subscribed = this.email.value">
        <label>Newsletter email <input name="email"></label><button>Subscribe</button></form>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture server");
  let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
  try {
    context = await chromium.launchPersistentContext(profile, {
      ...BROWSER,
      args: ["--remote-debugging-port=0"],
    });
    let port = "";
    await expect(async () => {
      port = (await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]!;
      expect(port).toMatch(/^\d+$/);
    }).toPass({ timeout: 5_000 });
    async function command(name: string, args: Record<string, unknown> = {}) {
      const { stdout } = await execute("python3", [helper, name, JSON.stringify(args)], {
        env: { ...process.env, RAKAZO_CDP_PORT: port },
        timeout: 30_000,
      });
      return JSON.parse(stdout);
    }
    type Snapshot = { tree: string; elements: { name: string; ref: string }[] };
    const names = (snapshot: Snapshot) => snapshot.elements.map((element) => element.name);
    const page = context.pages()[0]!;
    await page.goto(`http://127.0.0.1:${address.port}`);

    const top: Snapshot = await command("snapshot");
    expect(top.tree).toMatch(/^\[controls: showing \d+ of \d+\. Snapshot with a query/);
    expect(names(top)).not.toContain("Newsletter email");

    const found: Snapshot = await command("snapshot", { query: "newsletter" });
    expect(found.tree.startsWith('[controls matching "newsletter"]')).toBe(true);
    expect(names(found)).toEqual(["Newsletter email", "Subscribe"]);
    const ref = (name: string) => found.elements.find((element) => element.name === name)!.ref;
    expect(
      await command("act", {
        actions: [
          { kind: "fill", ref: ref("Newsletter email"), text: "reader@example.test" },
          { kind: "click", ref: ref("Subscribe") },
        ],
      }),
    ).toMatchObject({ ok: true, completed: 2 });
    expect(await page.evaluate(() => (window as { subscribed?: string }).subscribed)).toBe(
      "reader@example.test",
    );

    await page.evaluate(() => scrollTo(0, document.body.scrollHeight));
    const bottom: Snapshot = await command("snapshot");
    expect(names(bottom)).toContain("Subscribe");
    expect(names(bottom)).not.toContain("Read story 0");
  } finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// Common code widgets. Each expects real key presses, and most move focus between their boxes.
// The page logs untrusted key events, which real typing never produces, and when keys arrive.
// Ordinary fields come first, so they stay inside the snapshot's control limit.
const CODE_FIELDS = `<!doctype html><title>Code</title>
  <form id="plain" onsubmit="event.preventDefault(); window.submits = (window.submits || 0) + 1">
    <label>Name <input value="Ada"></label><label>Email <input type="email" value="ada@example.test"></label>
    <textarea aria-label="Notes">Old</textarea><label>Pin <input type="number"></label></form>
  <textarea aria-label="Message"
    onkeydown="if (event.key === 'Enter' && !event.shiftKey) window.sent = (window.sent || 0) + 1"></textarea>
  <section id="last">Last <div class="boxes" data-kind="last"></div></section>
  <section id="keys">Keys <div class="boxes" data-kind="keydown"></div></section>
  <section id="state">State <div class="boxes" data-kind="state"></div></section>
  <section id="single">Single <label style="position:relative;display:inline-block;width:240px;height:40px">
    <span id="single-boxes"></span><input aria-label="Code" autocomplete="one-time-code" maxlength="6"
      style="position:absolute;inset:0;opacity:0"></label></section>
  <section id="paste">Paste <div class="boxes" data-kind="paste"></div></section>
  <section id="overtype">Overtype <div class="boxes" data-kind="overtype"></div></section>
  <section id="split">Split <div class="boxes" data-kind="split" data-letters></div></section>
  <section id="submit">Submit <div class="boxes" data-kind="submit"></div></section>
  <section id="leave">Leave <div class="boxes" data-kind="leave"></div></section>
  <section id="eager">Eager <div class="boxes" data-kind="eager"></div></section>
  <section id="still">Still <div class="boxes" data-kind="still"></div></section>
  <section id="initial">Initial <div class="boxes" data-kind="last">
    <input aria-label="Middle initial" maxlength="1" value="Q"></div></section>
  <section id="rebuild">Rebuild <div></div></section>
  <section id="jump">Jump <div class="boxes" data-kind="jump"></div></section>
  <script>
    window.untrusted = 0;
    window.keyTimes = [];
    addEventListener("keydown", (event) => {
      if (!event.isTrusted) window.untrusted++;
      window.keyTimes.push(performance.now());
    }, true);
    for (const group of document.querySelectorAll(".boxes")) {
      const kind = group.dataset.kind;
      const id = group.closest("section").id;
      const accepts = (key) => (group.hasAttribute("data-letters") ? /^[0-9A-Z]$/i : /^[0-9]$/).test(key);
      const boxes = Array.from({ length: 6 }, (_, i) => {
        const box = document.createElement("input");
        box.maxLength = 1;
        box.setAttribute("aria-label", id + " " + (i + 1));
        (kind === "split" && i >= 3 ? group.lastElementChild : group).append(box);
        if (kind === "split" && i === 2) group.append("-", document.createElement("span"));
        return box;
      });
      const state = boxes.map(() => "");
      const spread = (from, chars) => {
        for (let j = 0; j < chars.length && from + j < 6; j++) boxes[from + j].value = chars[j];
        boxes[Math.min(from + chars.length, 5)].focus();
      };
      boxes.forEach((box, i) => {
        box.addEventListener("focus", () => box.select());
        // Plain boxes that never move focus themselves.
        if (kind === "still") return;
        if (kind === "keydown") {
          box.addEventListener("beforeinput", (event) => event.preventDefault());
          box.addEventListener("keydown", (event) => {
            if (!event.isTrusted || !accepts(event.key)) return;
            event.preventDefault();
            box.value = event.key;
            boxes[Math.min(i + 1, 5)].focus();
          });
          return;
        }
        box.addEventListener("input", (event) => {
          if (kind === "state") {
            // A controlled widget renders from its own state, which only real input events change.
            state[i] = accepts(event.data || "") ? event.data : "";
            boxes.forEach((b, j) => (b.value = state[j]));
            if (state[i] && i < 5) boxes[i + 1].focus();
            return;
          }
          const chars = box.value.split("").filter(accepts).join("");
          if (kind === "overtype" && chars.length > 1) {
            box.value = "";
            spread(i, chars.slice(1));
          } else {
            box.value = chars.slice(-1);
            if (box.value && i < 5) boxes[i + 1].focus();
          }
          if (kind === "submit" && boxes.every((b) => b.value)) location.href = "/done";
          // Pages that move on, or move focus to another field, before the code is complete.
          if (kind === "leave" && i === 2 && box.value) location.href = "/next";
          if (kind === "eager" && i === 2) location.href = "/next";
          if (kind === "jump" && i === 1) document.querySelector("#plain input").focus();
        });
        if (kind === "paste") {
          box.addEventListener("paste", (event) => {
            event.preventDefault();
            spread(i, event.clipboardData.getData("text").split("").filter(accepts));
          });
        }
      });
    }
    // A widget that draws all its boxes again, as new elements, on every input.
    const rebuild = document.querySelector("#rebuild div");
    const draw = (values, focus) => {
      rebuild.replaceChildren(...values.map((value, i) => {
        const box = document.createElement("input");
        box.maxLength = 1;
        box.value = value;
        box.setAttribute("aria-label", "rebuild " + (i + 1));
        box.addEventListener("input", () => {
          const next = Array.from(rebuild.children, (b) => b.value.replace(/[^0-9]/g, "").slice(-1));
          draw(next, next[i] ? Math.min(i + 1, 5) : i);
        });
        return box;
      }));
      if (focus !== undefined) rebuild.children[focus].focus();
    };
    draw(["", "", "", "", "", ""]);
    const single = document.querySelector("#single input");
    single.addEventListener("input", () => {
      single.value = single.value.replace(/[^0-9]/g, "");
      document.getElementById("single-boxes").textContent = single.value.split("").join(" ");
    });
  </script>`;

// An email code and a text-message code side by side in one element, both built from the same
// "Digit 1" to "Digit 6" boxes that move on by themselves.
const TWO_CODES = `<!doctype html><title>Two codes</title><style>input { width: 2em }</style>
  <div id="codes"></div>
  <script>
    const boxes = [];
    for (const label of ["Email", "Text message"]) {
      document.getElementById("codes").append(label + " ");
      for (let i = 0; i < 6; i++) {
        const box = document.createElement("input");
        box.maxLength = 1;
        box.setAttribute("aria-label", "Digit " + (i + 1));
        boxes.push(box);
        box.addEventListener("input", () => {
          if (box.value && i < 5) boxes[boxes.indexOf(box) + 1].focus();
        });
        document.getElementById("codes").append(box);
      }
    }
    for (const box of boxes.slice(0, 6)) box.value = "1";
  </script>`;

// Code pages that name only the first box, with the prompt, and leave the other boxes unnamed; some
// set no length limit and size their boxes narrow instead. Focus moves on by itself after each digit.
// "stray" moves focus to an unrelated field instead, "long" has more unnamed boxes than any code.
const FIRST_LABEL_ONLY = `<!doctype html><title>First label</title><style>input { width: 36px }</style>
  <section id="text"><label for="text-1">Code from Larkspur by text</label></section>
  <section id="app"></section><section id="call"></section><section id="stray"></section>
  <section id="long"></section>
  <section id="card">${["Card 1", "Card 2", "Card 3", "Card 4", "Expiry", "CVC"]
    .map(
      (hint) => `<input type="tel" inputmode="numeric" placeholder="${hint}" style="width:60px">`,
    )
    .join("")}</section>
  <section id="grid">${Array.from(
    { length: 8 },
    (_, i) =>
      `<input type="number" min="0" max="9" value="7" placeholder="Cell ${i + 1}" style="width:40px">`,
  ).join("")}</section>
  <script>
    const add = (id, attributes, label, count, next) => {
      const section = document.getElementById(id);
      const boxes = Array.from({ length: count }, (_, i) => {
        const box = document.createElement("input");
        for (const [name, value] of Object.entries(attributes)) box.setAttribute(name, value);
        if (i === 0 && label) box.setAttribute(label[0], label[1]);
        if (i === 0 && id === "text") box.id = "text-1";
        box.addEventListener("input", () => {
          box.value = box.value.replace(/[^0-9]/g, "").slice(-1);
          if (box.value) next(boxes, i)?.focus();
        });
        section.append(box);
        return box;
      });
    };
    const following = (boxes, i) => boxes[i + 1];
    add("text", { maxlength: "1" }, null, 6, following);
    add("app", { type: "tel", inputmode: "numeric", autocomplete: "one-time-code" },
      ["aria-label", "Code from Larkspur by app"], 6, following);
    add("call", { type: "number", min: "0", max: "9" }, ["aria-label", "Code from Larkspur by call"], 6, following);
    add("stray", { maxlength: "1" }, ["aria-label", "Stray code"], 4, (boxes, i) =>
      boxes[i + 1] ?? document.getElementById("phone"));
    document.getElementById("stray").insertAdjacentHTML("beforeend", '<input id="phone" aria-label="Phone" style="width:200px">');
    add("long", { maxlength: "1" }, ["aria-label", "Long code"], 10, following);
  </script>`;

test("live page helper types codes as real key presses into one-box-per-digit fields", async () => {
  test.setTimeout(240_000);
  const profile = await mkdtemp(path.join(os.tmpdir(), "page-browser-test-"));
  let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
  try {
    context = await chromium.launchPersistentContext(profile, {
      ...BROWSER,
      args: ["--remote-debugging-port=0"],
    });
    let port = "";
    await expect(async () => {
      port = (await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]!;
      expect(port).toMatch(/^\d+$/);
    }).toPass({ timeout: 5_000 });
    async function command(name: string, args: Record<string, unknown> = {}) {
      const { stdout } = await execute("python3", [helper, name, JSON.stringify(args)], {
        env: { ...process.env, RAKAZO_CDP_PORT: port },
        timeout: 30_000,
      });
      return JSON.parse(stdout);
    }
    // Each result carries a fresh snapshot, whose refs replace the previous ones.
    let elements: Array<{ name: string; ref: string; value?: string }> = [];
    const refresh = async () => {
      elements = (await command("snapshot")).elements;
    };
    async function type(name: string, text: string) {
      const ref = elements.find((element) => element.name === name)?.ref;
      expect(ref, name).toBeTruthy();
      const result = await command("act", { actions: [{ kind: "type", ref, text }] });
      elements = result.elements ?? [];
      return result;
    }
    const page = context.pages()[0]!;
    await page.route("https://code.example.test/**", async (route) => {
      // A slow next page keeps the one that is leaving on screen while the keys are typed.
      if (route.request().url().endsWith("/next")) await new Promise((r) => setTimeout(r, 500));
      await route.fulfill({
        contentType: "text/html",
        body: route.request().url().endsWith("/done")
          ? "<title>Signed in</title>"
          : route.request().url().endsWith("/two")
            ? TWO_CODES
            : route.request().url().endsWith("/first")
              ? FIRST_LABEL_ONLY
              : route.request().url().endsWith("/next")
                ? '<title>Next</title><input aria-label="Next" autofocus>'
                : CODE_FIELDS,
      });
    });
    const open = async () => {
      await page.goto("https://code.example.test/");
      await refresh();
    };
    const code = (section: string) =>
      page
        .locator(`#${section} input`)
        .evaluateAll((boxes) => boxes.map((box) => (box as HTMLInputElement).value).join(""));
    // From the first key press to the last, as the page saw them.
    const typingMs = () =>
      page.evaluate(() => {
        const times = (window as unknown as { keyTimes: number[] }).keyTimes.splice(0);
        return times.length ? times[times.length - 1]! - times[0]! : 0;
      });

    for (const section of ["last", "keys", "state", "paste", "overtype", "split"]) {
      await open();
      // One action enters the whole code; the result shows what landed in each box.
      expect(await type(`${section} 1`, "482913"), section).toMatchObject({
        ok: true,
        completed: 1,
      });
      expect(await typingMs(), section).toBeLessThan(2_000);
      expect(await code(section), section).toBe("482913");
      expect(elements.find((element) => element.name === `${section} 6`)?.value).toBe("3");
      // A partial code, then the full one typed from another box, replaces it.
      await type(`${section} 1`, "48");
      expect(await type(`${section} 4`, "482913")).toMatchObject({ ok: true });
      expect(await code(section), section).toBe("482913");
    }
    // Typing again replaces: twice in a row, and a wrong code then the right one.
    expect(await type("last 1", "482913")).toMatchObject({ ok: true });
    expect(await code("last")).toBe("482913");
    await type("last 1", "482931");
    await type("last 1", "482913");
    expect(await code("last")).toBe("482913");
    expect(await type("split 1", "A7K29Q")).toMatchObject({ ok: true });
    expect(await code("split")).toBe("A7K29Q");
    // Boxes the page filled itself are emptied first.
    await page.locator("#last input").evaluateAll((boxes) => {
      for (const box of boxes) (box as HTMLInputElement).value = "9";
    });
    await refresh();
    await type("last 1", "482913");
    expect(await code("last")).toBe("482913");
    // A key the widget refuses is reported, not claimed as done, and the error repeats no text.
    const refused = await type("last 1", "48291A");
    expect(refused).toMatchObject({ ok: false, completed: 1 });
    expect(refused.error).toContain("did not keep every character");
    expect(refused.error).not.toContain("48291A");

    // The real input of a drawn code field is transparent, and it is still listed and typed into.
    await page.locator("#single input").fill("123456");
    await refresh();
    expect(await type("Code", "482913")).toMatchObject({ ok: true });
    await expect(page.locator("#single input")).toHaveValue("482913");
    await expect(page.locator("#single-boxes")).toHaveText("4 8 2 9 1 3");

    // Ordinary fields: type replaces the text, and Enter goes only where a line break belongs.
    await type("Name", "Grace\n");
    await expect(page.getByLabel("Name")).toHaveValue("Grace");
    expect(await page.evaluate(() => (window as { submits?: number }).submits ?? 0)).toBe(0);
    await type("Email", "grace@example.test");
    await expect(page.getByLabel("Email")).toHaveValue("grace@example.test");
    await type("Notes", "é ß 中文 🙂\nline two");
    await expect(page.getByLabel("Notes")).toHaveValue("é ß 中文 🙂\nline two");
    // A chat box that sends on Enter gets line breaks, never a send.
    expect(await type("Message", "Hi\nsee you")).toMatchObject({ ok: true });
    await expect(page.getByLabel("Message")).toHaveValue("Hi\nsee you");
    expect(await page.evaluate(() => (window as { sent?: number }).sent ?? 0)).toBe(0);
    const long = "x".repeat(1_000);
    const started = Date.now();
    expect(await type("Notes", long)).toMatchObject({ ok: true });
    expect(Date.now() - started).toBeLessThan(20_000);
    await expect(page.getByLabel("Notes")).toHaveValue(long);
    expect(await type("Pin", "12a")).toMatchObject({ ok: false });
    expect(await page.evaluate(() => (window as { untrusted?: number }).untrusted)).toBe(0);

    // Typing into one code leaves another code on the page as it was.
    await open();
    await page.locator("#keys input").evaluateAll((boxes) => {
      for (const box of boxes) (box as HTMLInputElement).value = "7";
    });
    await type("last 1", "482913");
    expect(await code("keys")).toBe("777777");
    // Focus moved to another field mid-code: typing stops there and that field keeps its text.
    const jumped = await type("jump 1", "482913");
    expect(jumped).toMatchObject({ ok: false, completed: 0 });
    expect(jumped.error).toContain("Focus left the field");
    expect(jumped.error).not.toContain("482913");
    await expect(page.getByLabel("Name")).toHaveValue("Ada");
    // The page moved on mid-code: no key reaches the next page, even its focused field.
    const left = await type("leave 1", "482913");
    expect(left).toMatchObject({ ok: false, completed: 0, title: "Next" });
    expect(left.error).toContain("page changed while typing, after 3 of 6 characters");
    await expect(page.getByLabel("Next")).toHaveValue("");
    // The page moves on as soon as its filled boxes are emptied: not one key is typed.
    await open();
    await page.locator("#eager input").evaluateAll((boxes) => {
      for (const box of boxes) (box as HTMLInputElement).value = "7";
    });
    await refresh();
    const eager = await type("eager 1", "482913");
    expect(eager).toMatchObject({ ok: false, completed: 0, title: "Next" });
    expect(eager.error).toContain("page changed while typing, after 0 of 6 characters");
    await expect(page.getByLabel("Next")).toHaveValue("");

    // A code typed one character per box, into boxes that move on by themselves and boxes that don't.
    await open();
    for (const section of ["last", "still"]) {
      for (const [i, digit] of Array.from("482913").entries()) {
        expect(await type(`${section} ${i + 1}`, digit), section).toMatchObject({ ok: true });
      }
      expect(await code(section), section).toBe("482913");
    }
    // A one-letter field just before the boxes is not part of the code.
    await open();
    expect(await type("initial 1", "482913")).toMatchObject({ ok: true });
    expect(await code("initial")).toBe("Q482913");
    // Boxes drawn again as new elements on every input get the code, the first time and again.
    expect(await type("rebuild 1", "482913")).toMatchObject({ ok: true, completed: 1 });
    expect(await code("rebuild")).toBe("482913");
    expect(await type("rebuild 4", "482931")).toMatchObject({ ok: true });
    expect(await code("rebuild")).toBe("482931");

    // Adjacent codes can share their names, size, row and form without sharing their values.
    await page.evaluate(() => {
      document.body.innerHTML =
        '<form style="display:flex"><div id="left"></div><div id="right"></div></form>';
      for (const id of ["left", "right"]) {
        const group = document.getElementById(id)!;
        for (let i = 0; i < 6; i++) {
          const box = document.createElement("input");
          box.maxLength = 1;
          box.style.width = "20px";
          box.setAttribute("aria-label", `Digit ${i + 1}`);
          box.value = "7";
          box.addEventListener("input", () => {
            if (box.value) (box.nextElementSibling as HTMLInputElement | null)?.focus();
          });
          group.append(box);
        }
      }
    });
    await refresh();
    const right = elements.filter((element) => element.name === "Digit 1")[1]!.ref;
    expect(
      await command("act", { actions: [{ kind: "type", ref: right, text: "482913" }] }),
    ).toMatchObject({ ok: true });
    expect(await code("left")).toBe("777777");
    expect(await code("right")).toBe("482913");

    // Removing a widget and focusing a same-named replacement must stop the remaining keys.
    await page.evaluate(() => {
      document.getElementById("left")!.remove();
      const group = document.getElementById("right")!;
      group.querySelectorAll("input").forEach((box) => {
        box.value = "";
      });
      group.addEventListener(
        "input",
        () => {
          const replacement = group.cloneNode(true) as HTMLElement;
          replacement.querySelectorAll("input").forEach((box) => {
            box.value = "7";
          });
          group.replaceWith(replacement);
          replacement.querySelector("input")!.focus();
        },
        { once: true },
      );
    });
    await refresh();
    expect(await type("Digit 1", "482913")).toMatchObject({ ok: false, completed: 0 });
    expect(await code("right")).toBe("777777");

    // Typing into the second of two codes in one element leaves the first one as it was.
    await page.goto("https://code.example.test/two");
    await refresh();
    const second = elements.filter((element) => element.name === "Digit 1")[1]?.ref;
    expect(second).toBeTruthy();
    const typed = await command("act", {
      actions: [{ kind: "type", ref: second, text: "482913" }],
    });
    expect(typed).toMatchObject({ ok: true, completed: 1 });
    const digits = await page
      .locator("#codes input")
      .evaluateAll((boxes) => boxes.map((box) => (box as HTMLInputElement).value).join(""));
    expect(digits).toBe("111111482913");

    // Pages that name only the first box still get the whole code, with or without a length limit.
    await page.goto("https://code.example.test/first");
    await refresh();
    for (const [section, name] of [
      ["text", "Code from Larkspur by text"],
      ["app", "Code from Larkspur by app"],
      ["call", "Code from Larkspur by call"],
    ] as const) {
      expect(await type(name, "482913"), section).toMatchObject({ ok: true, completed: 1 });
      expect(await code(section), section).toBe("482913");
    }
    // Keys never go to an unrelated field: focus moving on to a phone field after the last box
    // stops the typing there, and a run of unnamed boxes longer than a code is not one code.
    for (const [section, name, typed] of [
      ["stray", "Stray code", "4829"],
      ["long", "Long code", "4"],
    ] as const) {
      await page.goto("https://code.example.test/first");
      await refresh();
      const stopped = await type(name, "482913");
      expect(stopped, section).toMatchObject({ ok: false, completed: 0 });
      expect(stopped.error, section).toContain(`after ${typed.length} of 6 characters`);
      expect(await code(section), section).toBe(typed);
    }
    await expect(page.getByLabel("Phone")).toHaveValue("");
    // Narrow number or card fields that no named box leads are not a code: the text stays in the
    // field it was typed into and the others keep what they had.
    await page.goto("https://code.example.test/first");
    await refresh();
    expect(await type("CVC", "123")).toMatchObject({ ok: true });
    expect(await code("card")).toBe("123");
    expect(await type("Cell 4", "12")).toMatchObject({ ok: true });
    expect(await code("grid")).toBe("777127777");

    // A widget that submits on its last digit: the step is done and the result is the next page.
    await open();
    expect(await type("submit 1", "482913")).toMatchObject({
      ok: true,
      completed: 1,
      title: "Signed in",
    });
  } finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test("live page helper types a purchase's card into a payment provider's frame only", async () => {
  const profile = await mkdtemp(path.join(os.tmpdir(), "page-browser-card-"));
  const merchant = "https://shop.example.test";
  const cardForm = `<!doctype html><title>Card</title>
    <input id="number" aria-label="Card number" autocomplete="cc-number" inputmode="numeric">
    <input id="expiry" aria-label="Expiry" autocomplete="cc-exp">
    <input id="cvc" aria-label="CVC" autocomplete="cc-csc">
    <input id="postal" aria-label="ZIP" autocomplete="billing postal-code" maxlength="3">
    <script>
      for (const field of document.querySelectorAll("input")) field.addEventListener("input", (event) => {
        if (!event.isTrusted) document.body.dataset.untrusted = "1";
      });
      const number = document.getElementById("number");
      number.addEventListener("input", () => {
        number.value = number.value.replace(/\\D/g, "").replace(/(\\d{4})(?=\\d)/g, "$1 ");
      });
      const expiry = document.getElementById("expiry");
      expiry.addEventListener("input", () => {
        const digits = expiry.value.replace(/\\D/g, "").slice(0, 4);
        expiry.value = digits.length > 2 ? digits.slice(0, 2) + " / " + digits.slice(2) : digits;
      });
    </script>`;
  const checkout = (frame: string) =>
    `<!doctype html><title>Checkout</title><h1>Pay</h1>
      <iframe src="${frame}" style="width:420px;height:220px;border:0"></iframe>`;
  let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
  try {
    context = await chromium.launchPersistentContext(profile, {
      ...BROWSER,
      // Payment frames run in their own renderer, as on any real checkout.
      args: ["--remote-debugging-port=0", "--site-per-process"],
    });
    let port = "";
    await expect(async () => {
      port = (await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]!;
      expect(port).toMatch(/^\d+$/);
    }).toPass({ timeout: 5_000 });
    async function command(name: string, args: Record<string, unknown> = {}) {
      const { stdout } = await execute("python3", [helper, name, JSON.stringify(args)], {
        env: { ...process.env, RAKAZO_CDP_PORT: port },
        timeout: 30_000,
      });
      return JSON.parse(stdout);
    }
    // Fulfilled here: nothing reaches the real payment provider.
    await context.route(/^https:\/\/(js\.stripe\.com|[a-z]+\.example\.test)\//, (route) => {
      const url = new URL(route.request().url());
      route.fulfill({
        contentType: "text/html",
        body: url.pathname.startsWith("/card")
          ? cardForm
          : checkout(
              url.pathname === "/ads"
                ? "https://ads.example.test/card"
                : "https://js.stripe.com/card",
            ),
      });
    });
    const fill = (cardField: string, text: string) =>
      command("act", {
        actions: [{ kind: "fill", text, origin: merchant, field: "card", cardField }],
      });
    const page = context.pages()[0]!;
    // The helper first reads the checkout after its card frame loaded, as when the person opened it.
    await page.goto(`${merchant}/checkout`);
    const card = page.frameLocator("iframe").locator("body");
    await expect(card.locator("#number")).toBeVisible();
    const snapshot = await command("snapshot");
    expect(snapshot.tree).toContain(
      "Card fields are in a payment frame: use fill_card without ref.",
    );
    expect(snapshot.tree).not.toContain("Embedded frames require desktop tools.");

    const number = "4242424242424242";
    const filled = [
      await fill("number", number),
      await fill("expiry", "12/34"),
      await fill("cvc", "123"),
    ];
    for (const result of filled) expect(result).toMatchObject({ ok: true, completed: 1 });
    expect(JSON.stringify(filled)).not.toContain(number);
    await expect(card.locator("#number")).toHaveValue("4242 4242 4242 4242");
    await expect(card.locator("#expiry")).toHaveValue("12 / 34");
    await expect(card.locator("#cvc")).toHaveValue("123");
    await expect(card.locator("#number")).toHaveCSS("-webkit-text-security", "disc");
    await expect(card).not.toHaveAttribute("data-untrusted", "1");

    expect(await fill("postal_code", "94110")).toEqual({
      ok: false,
      completed: 0,
      uncertain: false,
      error: "This field didn't accept the card, so it was cleared.",
    });
    await expect(card.locator("#postal")).toHaveValue("");

    await page.goto("https://elsewhere.example.test/checkout");
    await expect(card.locator("#number")).toBeVisible();
    expect(await fill("number", number)).toMatchObject({
      ok: false,
      completed: 0,
      uncertain: false,
      error: expect.stringMatching(/^The page is not on the merchant's site/),
    });
    await expect(card.locator("#number")).toHaveValue("");
    await page.goto(`${merchant}/ads`);
    await expect(card.locator("#number")).toBeVisible();
    // A frame from another site is read like any other, but never takes the card.
    const ads = (await command("snapshot")).tree;
    expect(ads).toContain("https://ads.example.test");
    expect(ads).not.toContain("Embedded frames require desktop tools.");
    expect(await fill("number", number)).toMatchObject({
      ok: false,
      completed: 0,
      error: expect.stringMatching(/^No field for this card detail/),
    });
    await expect(card.locator("#number")).toHaveValue("");
  } finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
  }
});
