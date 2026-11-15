import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import sharp from "sharp";
import { fetch as undiciFetch } from "undici";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FaviconResolver } from "./favicon.js";
import {
  createFaviconResolver,
  decodeIcoBitmap,
  faviconDataUrl,
  faviconOrigin,
  iconCandidates,
} from "./favicon.js";
import type { ResolveHostname } from "./network-address.js";

type Reply = { status?: number; headers?: Record<string, string>; body?: Uint8Array | string };

// One local server stands in for every site. The injected fetch sends each request to it with
// the site's host in a header, so the SSRF checks still see the public-looking test hostnames.
const routes = new Map<string, Reply | ((request: IncomingMessage) => Reply | Promise<Reply>)>();
const hits: string[] = [];
let server: Server;
let port = 0;

beforeAll(async () => {
  server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    // Local tools can probe any listening loopback port; only testFetch requests count.
    if (!request.headers["x-test-host"]) {
      response.writeHead(404).end();
      return;
    }
    const key = `${request.headers["x-test-host"]}${request.url}`;
    hits.push(key);
    const route = routes.get(key);
    const reply = typeof route === "function" ? await route(request) : route;
    response.writeHead(reply ? (reply.status ?? 200) : 404, reply?.headers ?? {});
    response.end(reply?.body ?? "");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  routes.clear();
  hits.length = 0;
});

const testFetch: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  const headers = { ...Object.fromEntries(new Headers(init?.headers)), "x-test-host": url.host };
  const { dispatcher: _dispatcher, ...rest } = (init ?? {}) as RequestInit & {
    dispatcher?: unknown;
  };
  return (await undiciFetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, {
    ...(rest as object),
    headers,
  })) as unknown as Response;
};

/** The icon an answer carries; the busy-retry flag has tests of its own. */
async function iconOf(resolver: FaviconResolver, origin: string) {
  return (await resolver.favicon(origin)).icon;
}

const publicResolver: ResolveHostname = async () => [{ address: "203.0.113.10", family: 4 }];

function resolvingTo(addresses: Record<string, string>): ResolveHostname {
  return async (hostname) => {
    const address = addresses[hostname] ?? "203.0.113.10";
    return [{ address, family: address.includes(":") ? 6 : 4 }];
  };
}

async function png(width: number, height: number): Promise<Uint8Array> {
  return sharp({
    create: { width, height, channels: 4, background: { r: 20, g: 20, b: 20, alpha: 1 } },
  })
    .png()
    .toBuffer();
}

function ico(images: Uint8Array[]): Uint8Array {
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach((image, index) => {
    const entry = 6 + index * 16;
    header.writeUInt32LE(image.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += image.length;
  });
  return Buffer.concat([header, ...images]);
}

const RED = [200, 30, 20] as const;

/**
 * An ICO bitmap of the given depth filled with RED, except the top-left pixel, which the
 * transparency mask hides. Palette depths use index 1 for RED.
 */
function bmpEntry(
  width: number,
  height: number,
  bitCount: 1 | 4 | 8 | 24 | 32 = 32,
  options: { alpha?: number; mask?: boolean } = {},
): Uint8Array {
  const paletteSize = bitCount <= 8 ? 2 ** bitCount : 0;
  const colorStride = Math.ceil((width * bitCount) / 32) * 4;
  const maskStride = Math.ceil(width / 32) * 4;
  const withMask = options.mask ?? true;
  const image = Buffer.alloc(
    40 + paletteSize * 4 + colorStride * height + (withMask ? maskStride * height : 0),
  );
  image.writeUInt32LE(40, 0);
  image.writeInt32LE(width, 4);
  image.writeInt32LE(height * 2, 8);
  image.writeUInt16LE(1, 12);
  image.writeUInt16LE(bitCount, 14);
  if (paletteSize) image.set([RED[2], RED[1], RED[0], 0], 40 + 4);
  const colorStart = 40 + paletteSize * 4;
  for (let row = 0; row < height; row += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = colorStart + row * colorStride;
      if (bitCount >= 24) {
        const pixel = at + x * (bitCount / 8);
        image.set([RED[2], RED[1], RED[0]], pixel);
        if (bitCount === 32) image[pixel + 3] = options.alpha ?? 255;
      } else {
        const bit = x * bitCount;
        image[at + (bit >> 3)]! |= 1 << (8 - bitCount - (bit & 7));
      }
    }
  }
  // Rows are stored bottom up, so the image's top row is the last mask row.
  if (withMask) image[colorStart + colorStride * height + (height - 1) * maskStride]! |= 0x80;
  return image;
}

/** Seeded so a failing mutation can be replayed. */
function random(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

function pngWithDeclaredSize(source: Uint8Array, width: number, height: number): Uint8Array {
  const copy = Buffer.from(source);
  copy.writeUInt32BE(width, 16);
  copy.writeUInt32BE(height, 20);
  return copy;
}

const html = (head: string): Reply => ({
  headers: { "content-type": "text/html; charset=utf-8" },
  body: `<!doctype html><html><head>${head}</head><body>hi</body></html>`,
});
const image = (body: Uint8Array, type = "image/png"): Reply => ({
  headers: { "content-type": type },
  body,
});

describe("favicon origins", () => {
  it.each([
    ["https://x.com", "https://x.com"],
    ["https://x.com/", "https://x.com"],
    ["HTTP://Example.TEST", "http://example.test"],
    ["https://example.test:443/", "https://example.test"],
    ["https://www.example.com", "https://example.com"],
    ["https://c2VjcmV0.leak.example.co.uk", "https://example.co.uk"],
    ["http://203.0.113.7", "http://203.0.113.7"],
  ])("accepts the bare origin %s, asking only its registrable domain", (input, origin) => {
    expect(faviconOrigin(input)).toBe(origin);
  });

  it.each([
    "https://x.com/elonmusk/status/1",
    "https://x.com/?token=secret",
    "https://x.com/#frag",
    "https://user:pass@x.com",
    "https://example.test:8443",
    "http://example.test:22",
    "ftp://example.test",
    "javascript:alert(1)",
    "not a url",
  ])("refuses %s", (input) => {
    expect(faviconOrigin(input)).toBeUndefined();
  });
});

describe("icon candidates", () => {
  it("reads icon links in order, touch icons last, and skips SVG and mask icons", () => {
    const candidates = iconCandidates(
      `<link rel="apple-touch-icon" href="/touch.png">
       <LINK REL='shortcut icon' HREF='/a.ico?v=1&amp;b=2'>
       <link rel="icon" type="image/svg+xml" href="/vector">
       <link rel="mask-icon" href="/mask.png">
       <link href="https://cdn.example.test/b.png" rel="icon" sizes="32x32">
       <link rel="icon" href="/c.svg">
       <link rel="icon" href="data:image/png;base64,AAAA">
       <link rel="stylesheet" href="/style.css">`,
      "https://www.example.test/home",
    );
    expect(candidates).toEqual([
      "https://www.example.test/a.ico?v=1&b=2",
      "https://cdn.example.test/b.png",
      "https://www.example.test/touch.png",
    ]);
  });
});

describe("document base", () => {
  it("resolves relative icon links against the first base href", () => {
    expect(
      iconCandidates(
        `<base href="https://cdn.example.test/assets/"><base href="https://other.example.test/">
         <link rel="icon" href="fav.png"><link rel="icon" href="/root.png">`,
        "https://site.example.test/home",
      ),
    ).toEqual(["https://cdn.example.test/assets/fav.png", "https://cdn.example.test/root.png"]);
  });

  it("resolves a relative base against the page and ignores a base that is not http(s)", () => {
    expect(
      iconCandidates(
        '<base href="/static/"><link rel="icon" href="i.png">',
        "https://site.example.test/home",
      ),
    ).toEqual(["https://site.example.test/static/i.png"]);
    expect(
      iconCandidates(
        '<base href="javascript:alert(1)"><link rel="icon" href="i.png">',
        "https://site.example.test/home",
      ),
    ).toEqual(["https://site.example.test/i.png"]);
  });
});

describe("favicon images", () => {
  it("re-encodes rasters as a 64 px PNG data URL", async () => {
    const url = await faviconDataUrl(await png(16, 16));
    expect(url).toMatch(/^data:image\/png;base64,/);
    const decoded = await sharp(Buffer.from(url!.split(",")[1]!, "base64")).metadata();
    expect([decoded.width, decoded.height, decoded.format]).toEqual([64, 64, "png"]);
  });

  it("refuses SVG, HTML and other non-image bytes", async () => {
    expect(
      await faviconDataUrl(
        new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'),
      ),
    ).toBeNull();
    expect(await faviconDataUrl(new TextEncoder().encode("<html></html>"))).toBeNull();
  });

  it("refuses 1×1 images", async () => {
    expect(await faviconDataUrl(await png(1, 1))).toBeNull();
    expect(await faviconDataUrl(ico([bmpEntry(1, 1)]))).toBeNull();
  });

  it("refuses rasters that declare more than a million pixels without decoding them", async () => {
    const lying = pngWithDeclaredSize(await png(16, 16), 8000, 8000);
    expect(await faviconDataUrl(lying)).toBeNull();
  });

  it("re-encodes an ICO as a 64 px PNG from its largest image", async () => {
    const url = await faviconDataUrl(ico([bmpEntry(16, 16), await png(32, 32)]));
    expect(url).toMatch(/^data:image\/png;base64,/);
    const decoded = await sharp(Buffer.from(url!.split(",")[1]!, "base64")).metadata();
    expect([decoded.width, decoded.height, decoded.format]).toEqual([64, 64, "png"]);
  });

  it.each([1, 4, 8, 24, 32] as const)(
    "decodes a %i-bit ICO bitmap with its mask",
    async (depth) => {
      const bitmap = decodeIcoBitmap(bmpEntry(16, 16, depth));
      expect(bitmap?.width).toBe(16);
      expect(bitmap?.height).toBe(16);
      const at = (x: number, y: number) => [
        ...bitmap!.rgba.subarray((y * 16 + x) * 4, (y * 16 + x) * 4 + 4),
      ];
      expect(at(5, 9)).toEqual([...RED, 255]);
      expect(at(0, 0)[3]).toBe(0);

      const url = await faviconDataUrl(ico([bmpEntry(16, 16, depth)]));
      const { data } = await sharp(Buffer.from(url!.split(",")[1]!, "base64"))
        .raw()
        .toBuffer({ resolveWithObject: true });
      expect([...data.subarray((32 * 64 + 32) * 4, (32 * 64 + 32) * 4 + 4)]).toEqual([...RED, 255]);
    },
  );

  it("uses the mask for a 32-bit bitmap whose alpha bytes are all zero", () => {
    const bitmap = decodeIcoBitmap(bmpEntry(8, 8, 32, { alpha: 0 }));
    expect(bitmap!.rgba[3]).toBe(0);
    expect(bitmap!.rgba[(8 + 1) * 4 + 3]).toBe(255);
  });

  it("accepts a 32-bit bitmap without a mask, but no other depth", () => {
    expect(decodeIcoBitmap(bmpEntry(8, 8, 32, { mask: false }))).toBeDefined();
    expect(decodeIcoBitmap(bmpEntry(8, 8, 24, { mask: false }))).toBeUndefined();
    expect(decodeIcoBitmap(bmpEntry(8, 8, 32, { mask: false, alpha: 0 }))).toBeUndefined();
  });

  it.each([
    ["a header size past the end", (b: Buffer) => b.writeUInt32LE(b.length + 1, 0)],
    ["a header size under 40", (b: Buffer) => b.writeUInt32LE(12, 0)],
    ["a zero width", (b: Buffer) => b.writeInt32LE(0, 4)],
    ["a negative width", (b: Buffer) => b.writeInt32LE(-16, 4)],
    ["a width over 256", (b: Buffer) => b.writeInt32LE(4096, 4)],
    ["a negative height", (b: Buffer) => b.writeInt32LE(-32, 8)],
    ["a height over 256", (b: Buffer) => b.writeInt32LE(8192, 8)],
    ["an unsupported depth", (b: Buffer) => b.writeUInt16LE(16, 14)],
    ["compression", (b: Buffer) => b.writeUInt32LE(1, 16)],
    ["more palette colours than the depth allows", (b: Buffer) => b.writeUInt32LE(257, 32)],
    ["a palette too short for the pixels", (b: Buffer) => b.writeUInt32LE(1, 32)],
  ])("refuses a bitmap with %s", (_name, lie) => {
    const bitmap = Buffer.from(bmpEntry(16, 16, 8));
    lie(bitmap);
    expect(decodeIcoBitmap(bitmap)).toBeUndefined();
  });

  it("refuses a bitmap cut short anywhere", () => {
    for (const depth of [1, 4, 8, 24, 32] as const) {
      const bitmap = bmpEntry(16, 16, depth, { mask: depth !== 32 });
      for (let length = 0; length < bitmap.length; length += 1) {
        expect(decodeIcoBitmap(bitmap.subarray(0, length))).toBeUndefined();
      }
    }
  });

  it("never throws or reads past the end on mutated ICO files", async () => {
    const next = random(1275);
    const samples = [
      ...([1, 4, 8, 24, 32] as const).map((depth) => ico([bmpEntry(16, 16, depth)])),
      ico([bmpEntry(8, 8, 4), bmpEntry(32, 32, 8)]),
    ];
    for (const sample of samples) {
      for (let round = 0; round < 60; round += 1) {
        const mutated = Buffer.from(sample.subarray(0, Math.floor(next() * sample.length) + 1));
        for (let flip = 0; flip < 1 + Math.floor(next() * 6); flip += 1) {
          // Mostly the headers, where a lie does the most damage.
          const at = Math.floor(
            next() * Math.min(mutated.length, next() < 0.7 ? 80 : mutated.length),
          );
          mutated[at] = Math.floor(next() * 256);
        }
        const url = await faviconDataUrl(mutated);
        expect(url === null || url.startsWith("data:image/png;base64,")).toBe(true);
      }
    }
  });

  it("refuses an ICO with any image larger than 256 px, whatever its directory says", async () => {
    const big = pngWithDeclaredSize(await png(16, 16), 4096, 4096);
    expect(await faviconDataUrl(ico([bmpEntry(16, 16), big]))).toBeNull();
    expect(await faviconDataUrl(ico([bmpEntry(512, 16)]))).toBeNull();
  });

  it("refuses an ICO whose entries point outside the file", async () => {
    const broken = Buffer.from(ico([bmpEntry(16, 16)]));
    broken.writeUInt32LE(broken.length, 6 + 12);
    expect(await faviconDataUrl(broken)).toBeNull();
  });
});

describe("favicon resolver", () => {
  it.each([true, false])("ignores commented icons and base tags (live icon: %s)", async (live) => {
    routes.set(
      "site.test/",
      html(`
      <!-- <base href="https://old.test/">
      <link rel="icon" href="/old-a.png">
      <link rel="icon" href="/old-b.png">
      <link rel="icon" href="/old-c.png"> -->
      <link rel="icon" href="live.png">
    `),
    );
    const bytes = await png(32, 32);
    if (live) routes.set("site.test/live.png", image(bytes));
    routes.set("site.test/favicon.ico", image(bytes));
    const resolver = createFaviconResolver({ fetch: testFetch, resolveHostname: publicResolver });

    expect(await iconOf(resolver, "https://site.test")).toMatch(/^data:image\/png;base64,/);
    expect(hits).toEqual([
      "site.test/",
      "site.test/live.png",
      ...(!live ? ["site.test/favicon.ico"] : []),
    ]);
  });

  it("fetches only the origin root and the icon it declares", async () => {
    routes.set("site.test/", html('<link rel="icon" href="/static/icon.png">'));
    routes.set("site.test/static/icon.png", image(await png(32, 32)));
    const resolver = createFaviconResolver({ fetch: testFetch, resolveHostname: publicResolver });

    expect(await iconOf(resolver, "https://site.test")).toMatch(/^data:image\/png;base64,/);
    expect(hits).toEqual(["site.test/", "site.test/static/icon.png"]);
  });

  it("follows a public redirect and resolves icons against the final page", async () => {
    routes.set("short.test/", {
      status: 301,
      headers: { location: "https://www.short.test/home" },
    });
    routes.set("www.short.test/home", html('<link rel="icon" href="icon.png">'));
    routes.set("www.short.test/icon.png", image(await png(32, 32)));
    const resolver = createFaviconResolver({ fetch: testFetch, resolveHostname: publicResolver });

    expect(await iconOf(resolver, "https://short.test")).toMatch(/^data:image\/png/);
    expect(hits).toEqual(["short.test/", "www.short.test/home", "www.short.test/icon.png"]);
  });

  it("falls back to /favicon.ico on the origin the page redirected to", async () => {
    routes.set("moved.test/", { status: 301, headers: { location: "https://www.moved.test/" } });
    routes.set("www.moved.test/", html(""));
    routes.set("www.moved.test/favicon.ico", image(await png(32, 32)));
    const resolver = createFaviconResolver({ fetch: testFetch, resolveHostname: publicResolver });

    expect(await iconOf(resolver, "https://moved.test")).toMatch(/^data:image\/png/);
    expect(hits).toEqual(["moved.test/", "www.moved.test/", "www.moved.test/favicon.ico"]);
  });

  it("falls back to /favicon.ico when the page declares nothing or fails", async () => {
    routes.set("plain.test/", { status: 500 });
    routes.set("plain.test/favicon.ico", image(ico([bmpEntry(16, 16, 8)]), "image/x-icon"));
    const resolver = createFaviconResolver({ fetch: testFetch, resolveHostname: publicResolver });

    expect(await iconOf(resolver, "https://plain.test")).toMatch(/^data:image\/png/);
    expect(hits).toEqual(["plain.test/", "plain.test/favicon.ico"]);
  });

  it("uses an icon whose bytes are an image whatever type the server declared", async () => {
    routes.set("typed.test/", html('<link rel="icon" href="/i.png">'));
    routes.set("typed.test/i.png", image(await png(32, 32), "text/plain"));
    const resolver = createFaviconResolver({ fetch: testFetch, resolveHostname: publicResolver });

    expect(await iconOf(resolver, "https://typed.test")).toMatch(/^data:image\/png;base64,/);
  });

  it("refuses HTML declared as an image", async () => {
    routes.set("liar.test/", html('<link rel="icon" href="/i.png">'));
    routes.set("liar.test/i.png", image(new TextEncoder().encode("<html>hi</html>"), "image/png"));
    routes.set("liar.test/favicon.ico", image(new TextEncoder().encode("<html/>"), "image/x-icon"));
    const resolver = createFaviconResolver({ fetch: testFetch, resolveHostname: publicResolver });

    expect(await iconOf(resolver, "https://liar.test")).toBeNull();
  });

  it("skips an SVG served as an icon and stops after three image fetches", async () => {
    routes.set(
      "many.test/",
      html(
        ["/1.png", "/2.png", "/3.png", "/4.png"]
          .map((href) => `<link rel="icon" href="${href}">`)
          .join(""),
      ),
    );
    const svg = image(new TextEncoder().encode("<svg/>"), "image/svg+xml");
    for (const path of ["/1.png", "/2.png", "/3.png", "/4.png", "/favicon.ico"]) {
      routes.set(`many.test${path}`, svg);
    }
    const resolver = createFaviconResolver({ fetch: testFetch, resolveHostname: publicResolver });

    expect(await iconOf(resolver, "https://many.test")).toBeNull();
    expect(hits).toEqual(["many.test/", "many.test/1.png", "many.test/2.png", "many.test/3.png"]);
  });

  it("reads icons from the first 256 KB of a longer page", async () => {
    routes.set("long.test/", html(`<link rel="icon" href="/i.png"><p>${"x".repeat(300_000)}</p>`));
    routes.set("long.test/i.png", image(await png(32, 32)));
    const resolver = createFaviconResolver({ fetch: testFetch, resolveHostname: publicResolver });

    expect(await iconOf(resolver, "https://long.test")).toMatch(/^data:image\/png/);
  });

  it("refuses an icon larger than 64 KB", async () => {
    routes.set("huge.test/", html('<link rel="icon" href="/i.png">'));
    routes.set("huge.test/i.png", image(new Uint8Array(70 * 1024)));
    routes.set("huge.test/favicon.ico", image(new Uint8Array(70 * 1024)));
    const resolver = createFaviconResolver({ fetch: testFetch, resolveHostname: publicResolver });

    expect(await iconOf(resolver, "https://huge.test")).toBeNull();
  });

  it("caches hits and misses per origin and shares one lookup between concurrent callers", async () => {
    let now = 0;
    routes.set("cached.test/", html(""));
    routes.set("cached.test/favicon.ico", image(await png(32, 32)));
    routes.set("missing.test/", html(""));
    const resolver = createFaviconResolver({
      fetch: testFetch,
      resolveHostname: publicResolver,
      now: () => now,
    });

    const [first, second] = await Promise.all([
      iconOf(resolver, "https://cached.test"),
      iconOf(resolver, "https://cached.test/"),
    ]);
    expect(first).toBe(second);
    expect(await resolver.favicon("https://missing.test")).toEqual({ icon: null });
    expect(hits).toHaveLength(4);

    now += 23 * 60 * 60 * 1000;
    await iconOf(resolver, "https://cached.test");
    await iconOf(resolver, "https://missing.test");
    expect(hits).toHaveLength(4);

    now += 2 * 60 * 60 * 1000;
    await iconOf(resolver, "https://missing.test");
    expect(hits).toHaveLength(6);
    await iconOf(resolver, "https://cached.test");
    expect(hits).toHaveLength(6);

    now += 7 * 24 * 60 * 60 * 1000;
    await iconOf(resolver, "https://cached.test");
    expect(hits).toHaveLength(8);
  });

  it("keeps cached icons under a byte budget, dropping the least recently used", async () => {
    const icon = await png(32, 32);
    for (const site of ["lru-a", "lru-b", "lru-c"]) {
      routes.set(`${site}.test/`, html(""));
      routes.set(`${site}.test/favicon.ico`, image(icon));
    }
    const size = (await faviconDataUrl(icon))!.length;
    const resolver = createFaviconResolver({
      fetch: testFetch,
      resolveHostname: publicResolver,
      // Room for two icons, not three.
      limits: { maxCachedIconBytes: size * 2 + size / 2 },
    });
    await iconOf(resolver, "https://lru-a.test");
    await iconOf(resolver, "https://lru-b.test");
    await iconOf(resolver, "https://lru-a.test"); // a is now the most recently used
    await iconOf(resolver, "https://lru-c.test");
    hits.length = 0;

    await iconOf(resolver, "https://lru-a.test");
    await iconOf(resolver, "https://lru-c.test");
    expect(hits).toEqual([]);
    await iconOf(resolver, "https://lru-b.test");
    expect(hits).toEqual(["lru-b.test/", "lru-b.test/favicon.ico"]);
  });

  it("does not keep an icon larger than the whole byte budget", async () => {
    routes.set("big-ico.test/", html(""));
    routes.set("big-ico.test/favicon.ico", image(ico([bmpEntry(64, 64), bmpEntry(32, 32)])));
    const resolver = createFaviconResolver({
      fetch: testFetch,
      resolveHostname: publicResolver,
      limits: { maxCachedIconBytes: 64 },
    });
    expect(await iconOf(resolver, "https://big-ico.test")).toMatch(/^data:image\/png/);
    await iconOf(resolver, "https://big-ico.test");
    expect(hits).toHaveLength(4);
  });

  it("caches refusals and errors as misses", async () => {
    let lookups = 0;
    const resolver = createFaviconResolver({
      fetch: testFetch,
      resolveHostname: async () => {
        lookups += 1;
        return [{ address: "127.0.0.1", family: 4 }];
      },
    });
    expect(await iconOf(resolver, "https://internal.test")).toBeNull();
    const afterFirst = lookups;
    expect(await iconOf(resolver, "https://internal.test")).toBeNull();
    expect(lookups).toBe(afterFirst);
    expect(hits).toEqual([]);
  });

  it("resolves at most four origins at once", async () => {
    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    for (let index = 0; index < 8; index += 1) {
      routes.set(`slow${index}.test/`, async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active -= 1;
        return { status: 404 };
      });
    }
    const resolver = createFaviconResolver({ fetch: testFetch, resolveHostname: publicResolver });
    const lookups = Array.from({ length: 8 }, (_, index) =>
      iconOf(resolver, `https://slow${index}.test`),
    );
    while (releases.length < 4) await new Promise((resolve) => setTimeout(resolve, 5));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(releases).toHaveLength(4);
    let settled = false;
    const results = Promise.all(lookups).finally(() => {
      settled = true;
    });
    while (!settled) {
      for (const release of releases.splice(0)) release();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(await results).toEqual(Array(8).fill(null));
    expect(peak).toBe(4);
  });

  async function holdSlots(resolver: ReturnType<typeof createFaviconResolver>, count = 4) {
    const releases: Array<() => void> = [];
    const lookups = Array.from({ length: count }, (_, index) => {
      routes.set(`hold${index}.test/`, async () => {
        await new Promise<void>((resolve) => releases.push(resolve));
        return { status: 404 };
      });
      return iconOf(resolver, `https://hold${index}.test`);
    });
    while (releases.length < count) await new Promise((resolve) => setTimeout(resolve, 5));
    return async () => {
      let settled = false;
      const all = Promise.all(lookups).finally(() => {
        settled = true;
      });
      while (!settled) {
        for (const release of releases.splice(0)) release();
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await all;
    };
  }

  it("turns lookups beyond a full queue away at once, as busy rather than missing", async () => {
    const resolver = createFaviconResolver({
      fetch: testFetch,
      resolveHostname: publicResolver,
      limits: { maxWaiting: 2, maxWaitMs: 60_000 },
    });
    const releaseAll = await holdSlots(resolver);
    const queued = [
      iconOf(resolver, "https://queued0.test"),
      iconOf(resolver, "https://queued1.test"),
    ];

    expect(await resolver.favicon("https://extra.test")).toEqual({ icon: null, retry: true });
    expect(hits.filter((hit) => hit.startsWith("extra.test"))).toEqual([]);

    await releaseAll();
    await Promise.all(queued);
    await iconOf(resolver, "https://extra.test");
    expect(hits).toContain("extra.test/");
  });

  it("stops waiting for a slot after the wait cap, as busy rather than missing", async () => {
    const resolver = createFaviconResolver({
      fetch: testFetch,
      resolveHostname: publicResolver,
      limits: { maxWaitMs: 50 },
    });
    const releaseAll = await holdSlots(resolver);

    expect(await resolver.favicon("https://late.test")).toEqual({ icon: null, retry: true });
    expect(hits.filter((hit) => hit.startsWith("late.test"))).toEqual([]);

    await releaseAll();
    await iconOf(resolver, "https://late.test");
    expect(hits).toContain("late.test/");
  });

  it("ends a lookup whose image is still decoding at the deadline", async () => {
    routes.set("decode.test/favicon.ico", image(await png(32, 32)));
    let decodeStarted = false;
    const resolver = createFaviconResolver({
      fetch: testFetch,
      resolveHostname: publicResolver,
      limits: { deadlineMs: 300 },
      decode: () => {
        decodeStarted = true;
        return new Promise(() => undefined);
      },
    });
    const started = Date.now();
    expect(await resolver.favicon("https://decode.test")).toEqual({ icon: null });
    expect(decodeStarted).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
    // Remembered as a miss, like any lookup that ran out of time.
    await resolver.favicon("https://decode.test");
    expect(hits).toEqual(["decode.test/", "decode.test/favicon.ico"]);
  });

  it("ends a slow lookup at its deadline and remembers the miss", async () => {
    let release: () => void = () => undefined;
    routes.set("stall.test/", async () => {
      await new Promise<void>((resolve) => (release = resolve));
      return html('<link rel="icon" href="/i.png">');
    });
    const resolver = createFaviconResolver({
      fetch: testFetch,
      resolveHostname: publicResolver,
      limits: { deadlineMs: 100 },
    });
    const started = Date.now();
    expect(await iconOf(resolver, "https://stall.test")).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
    release();

    expect(await iconOf(resolver, "https://stall.test")).toBeNull();
    expect(hits).toEqual(["stall.test/"]);
  });
});

describe("favicon SSRF guard", () => {
  it.each([
    ["127.0.0.1", "loopback"],
    ["10.1.2.3", "RFC 1918"],
    ["172.16.0.5", "RFC 1918"],
    ["192.168.1.1", "RFC 1918"],
    ["169.254.169.254", "cloud metadata / link-local"],
    ["100.64.0.1", "CGNAT"],
    ["0.0.0.0", "unspecified"],
    ["224.0.0.1", "multicast"],
    ["::1", "IPv6 loopback"],
    ["::", "IPv6 unspecified"],
    ["fe80::1", "IPv6 link-local"],
    ["fc00::1", "IPv6 unique local"],
    ["fd00:ec2::254", "AWS IPv6 metadata"],
    ["ff02::1", "IPv6 multicast"],
    ["::ffff:127.0.0.1", "IPv4-mapped loopback"],
    ["::ffff:169.254.169.254", "IPv4-mapped metadata"],
    ["64:ff9b::a00:1", "NAT64 of 10.0.0.1"],
    ["2002:c0a8:101::1", "6to4 of 192.168.1.1"],
  ])("refuses a host resolving to %s (%s) without connecting", async (address) => {
    const resolver = createFaviconResolver({
      fetch: testFetch,
      resolveHostname: resolvingTo({ "victim.test": address }),
    });
    expect(await iconOf(resolver, "https://victim.test")).toBeNull();
    expect(hits).toEqual([]);
  });

  it.each([
    "http://localhost",
    "http://127.0.0.1",
    "http://[::1]",
    "http://169.254.169.254",
    "http://metadata.google.internal",
    "http://printer.local",
  ])("refuses the internal origin %s without connecting", async (origin) => {
    const resolver = createFaviconResolver({ fetch: testFetch, resolveHostname: publicResolver });
    expect(await iconOf(resolver, origin)).toBeNull();
    expect(hits).toEqual([]);
  });

  it.each([
    ["http://127.0.0.1/", "loopback IPv4"],
    ["http://[::ffff:10.0.0.1]/", "mapped private"],
    ["http://[fd00::1]/", "IPv6 unique local"],
    ["http://intranet.test/", "a name resolving privately"],
    ["https://site.test:8443/", "a non-web port"],
    ["file:///etc/passwd", "a non-http scheme"],
  ])("refuses a redirect to %s (%s)", async (location) => {
    routes.set("redirect.test/", { status: 302, headers: { location } });
    routes.set("redirect.test/favicon.ico", { status: 302, headers: { location } });
    const resolver = createFaviconResolver({
      fetch: testFetch,
      resolveHostname: resolvingTo({ "intranet.test": "10.0.0.8" }),
    });

    expect(await iconOf(resolver, "https://redirect.test")).toBeNull();
    expect(hits).toEqual(["redirect.test/", "redirect.test/favicon.ico"]);
  });

  it("refuses icons a base href points at a private address", async () => {
    routes.set(
      "based.test/",
      html('<base href="http://169.254.169.254/latest/"><link rel="icon" href="icon.png">'),
    );
    const resolver = createFaviconResolver({ fetch: testFetch, resolveHostname: publicResolver });

    expect(await iconOf(resolver, "https://based.test")).toBeNull();
    // The base never moves the origin's own fallback.
    expect(hits).toEqual(["based.test/", "based.test/favicon.ico"]);
  });

  it("refuses an icon link that points at a private address", async () => {
    routes.set("page.test/", html('<link rel="icon" href="http://10.0.0.1/icon.png">'));
    const resolver = createFaviconResolver({ fetch: testFetch, resolveHostname: publicResolver });

    expect(await iconOf(resolver, "https://page.test")).toBeNull();
    expect(hits).toEqual(["page.test/", "page.test/favicon.ico"]);
  });

  it("stops after three redirects", async () => {
    for (let index = 0; index < 5; index += 1) {
      routes.set(`hop.test/${index}`, {
        status: 302,
        headers: { location: `/${index + 1}` },
      });
    }
    routes.set("hop.test/", { status: 302, headers: { location: "/0" } });
    routes.set("hop.test/favicon.ico", { status: 302, headers: { location: "/0" } });
    const resolver = createFaviconResolver({ fetch: testFetch, resolveHostname: publicResolver });

    expect(await iconOf(resolver, "https://hop.test")).toBeNull();
    expect(hits).toEqual([
      "hop.test/",
      "hop.test/0",
      "hop.test/1",
      "hop.test/2",
      "hop.test/favicon.ico",
      "hop.test/0",
      "hop.test/1",
      "hop.test/2",
    ]);
  });

  it("sends no cookies or credentials and a fixed user agent", async () => {
    let seen: IncomingMessage["headers"] = {};
    routes.set("headers.test/", (request) => {
      seen = request.headers;
      return { status: 404 };
    });
    const resolver = createFaviconResolver({ fetch: testFetch, resolveHostname: publicResolver });
    await iconOf(resolver, "https://headers.test");

    expect(seen.cookie).toBeUndefined();
    expect(seen.authorization).toBeUndefined();
    expect(seen["user-agent"]).toMatch(/^Rakazo\//);
  });
});
