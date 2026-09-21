import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, join, sep } from "node:path";

const workspace = resolve(import.meta.dirname, "../..");
const rootRequire = createRequire(join(workspace, "package.json"));
const sharp = rootRequire("sharp");
const { chromium } = rootRequire("playwright");
const args = process.argv.slice(2);
const options = {};
for (let index = 0; index < args.length; index += 2) {
    if (!["--captures", "--out"].includes(args[index]) || !args[index + 1]) {
        throw new Error("Use --captures <captures.json> --out <output directory>.");
    }
    options[args[index].slice(2)] = resolve(args[index + 1]);
}
if (!options.captures || !options.out) throw new Error("Both --captures and --out are required.");
const manifest = JSON.parse(await readFile(options.captures, "utf8"));
if (
    manifest.version !== 2 ||
    !["iphone", "ipad"].includes(manifest.device) ||
    !manifest.provenance ||
    typeof manifest.font !== "string" ||
    typeof manifest.supportFont !== "string"
) {
    throw new Error(
        "Expected a version-2 capture manifest with device, provenance and explicit fonts.",
    );
}
const profile =
    manifest.device === "iphone"
        ? {
              width: 660,
              height: 1434,
              headline: 66,
              support: 26,
              deviceWidth: 552,
              desktopWidth: 832,
              gutter: 40,
              top: 48,
              rawWidth: 1206,
              rawHeight: 2622,
          }
        : {
              width: 1032,
              height: 1376,
              headline: 76,
              support: 28,
              deviceWidth: 770,
              desktopWidth: 1080,
              gutter: 64,
              top: 40,
              rawWidth: 2064,
              rawHeight: 2752,
          };
const supplied = manifest.provenance;
if (
    !/^[a-f0-9]{40,64}$/u.test(supplied.mobileCommit ?? "") ||
    !/^[a-f0-9]{40,64}$/u.test(supplied.desktopCommit ?? "") ||
    typeof supplied.mobileDirty !== "boolean" ||
    typeof supplied.desktopDirty !== "boolean" ||
    !/^[a-f0-9-]{36}$/iu.test(supplied.simulator ?? "") ||
    typeof supplied.capturedAt !== "string" ||
    !Number.isFinite(Date.parse(supplied.capturedAt)) ||
    !Array.isArray(supplied.fixtures) ||
    supplied.fixtures.length > 20 ||
    supplied.fixtures.some((value) => typeof value !== "string" || value.length > 512)
)
    throw new Error(
        "Invalid capture provenance; provide revision, Simulator, time, and fixture descriptions only.",
    );
// A richer runtime object must never carry auth or environment values into the
// exported composition report. Copy only the declared non-secret contract.
const provenance = {
    mobileCommit: supplied.mobileCommit,
    desktopCommit: supplied.desktopCommit,
    mobileDirty: supplied.mobileDirty,
    desktopDirty: supplied.desktopDirty,
    simulator: supplied.simulator,
    capturedAt: supplied.capturedAt,
    fixtures: supplied.fixtures,
};

const specs = [
    {
        id: "models",
        title: ["Your models.", "One place."],
        detail: ["Use existing Claude,", "ChatGPT, Grok subscriptions"],
    },
    {
        id: "sessions",
        title: ["Every agent.", "Within reach."],
        detail: ["Follow your work across projects."],
    },
    {
        id: "desktop",
        title: ["From desk", "to anywhere."],
        detail: ["Your desktop companion."],
    },
    {
        id: "multiplayer",
        title: ["Build", "together."],
        detail: ["You, your team, and your agents."],
    },
    {
        id: "source",
        title: ["Open source", "MIT license"],
        detail: ["Read, modify and deploy anywhere"],
    },
];
const escape = (value) =>
    value.replace(
        /[&<>"']/gu,
        (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char],
    );
const data = (buffer, type) => `data:${type};base64,${buffer.toString("base64")}`;
const images = {};
const sources = {};
const captureDirectory = await realpath(dirname(options.captures));
for (const id of specs.map((spec) => spec.id)) {
    if (typeof manifest.screens?.[id] !== "string")
        throw new Error(`Missing explicit ${id} capture.`);
    const selected = manifest.screens[id];
    if (isAbsolute(selected)) throw new Error("Screens must be relative to the capture directory.");
    const path = resolve(captureDirectory, selected);
    const info = await lstat(path);
    const canonical = await realpath(path);
    const inside = relative(captureDirectory, canonical);
    if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        canonical !== path ||
        inside === ".." ||
        inside.startsWith(`..${sep}`) ||
        isAbsolute(inside)
    ) {
        throw new Error("Every screen must be an ordinary file inside the capture directory.");
    }
    const bytes = await readFile(path);
    const metadata = await sharp(bytes).metadata();
    if (metadata.width < 700 || metadata.height < 500)
        throw new Error(`${id} capture is too small.`);
    if (
        id !== "desktop" &&
        (metadata.width !== profile.rawWidth || metadata.height !== profile.rawHeight)
    ) {
        throw new Error(
            `${id} must be a native ${profile.rawWidth}x${profile.rawHeight} ${manifest.device} capture.`,
        );
    }
    const displayWidth =
        id === "desktop"
            ? profile.desktopWidth
            : manifest.device === "iphone"
              ? (profile.deviceWidth * 1206) / 1406
              : profile.deviceWidth;
    if (metadata.width < displayWidth * 2) {
        throw new Error(`${id} would upscale source pixels; capture it at higher resolution.`);
    }
    images[id] = data(await sharp(bytes).png().toBuffer(), "image/png");
    sources[id] = {
        width: metadata.width,
        height: metadata.height,
        sha256: createHash("sha256").update(bytes).digest("hex"),
    };
}
const font = data(await readFile(resolve(dirname(options.captures), manifest.font)), "font/ttf");
const supportFont = data(
    await readFile(resolve(dirname(options.captures), manifest.supportFont)),
    "font/ttf",
);
const frame = data(
    await readFile(
        join(workspace, "scripts/app-store/assets/iphone-16-pro-black.png"),
    ),
    "image/png",
);
const screenMask = data(
    await readFile(join(workspace, "scripts/app-store/assets/screen-alpha.png")),
    "image/png",
);
// Require a fresh export directory: rerendering may never overwrite a raw
// capture or the last selected image set, even if the caller mixes paths.
await mkdir(dirname(options.out), { recursive: true });
await mkdir(options.out);
const browser = await chromium.launch({ headless: true });
const report = {
    version: 2,
    device: manifest.device,
    publicationStatus: "review-draft",
    provenance,
    sources,
    cards: [],
};
try {
    const page = await browser.newPage({
        viewport: { width: profile.width, height: profile.height },
        deviceScaleFactor: 2,
    });
    // Entirely offline. Compositions embed the approved local capture bytes;
    // no page can fetch fonts, analytics, arbitrary files, or external content.
    await page.route("**/*", (route) => route.abort());
    for (const [index, spec] of specs.entries()) {
        const desktop = spec.id === "desktop";
        const visual = desktop
            ? `<img class="desktop" src="${images.desktop}" alt="">`
            : manifest.device === "iphone"
              ? `<div class="phone"><img class="screen" src="${images[spec.id]}" alt=""><img class="bezel" src="${frame}" alt=""></div>`
              : `<img class="tablet" src="${images[spec.id]}" alt="">`;
        await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
            @font-face{font-family:Headline;src:url('${font}') format('truetype');font-weight:700;font-display:block}
            @font-face{font-family:Support;src:url('${supportFont}') format('truetype');font-weight:400;font-display:block}
            *{box-sizing:border-box}html,body{margin:0;width:${profile.width}px;height:${profile.height}px;overflow:hidden}
            body{background:#f5f0e7;color:#183f38;font-family:Support,sans-serif;display:flex;flex-direction:column}
            main{display:flex;flex-direction:column;align-items:center;gap:28px;width:100%;height:100%;padding:${profile.top}px ${profile.gutter}px 0}
            header{display:flex;flex-direction:column;align-items:center;gap:16px;width:100%;flex:none;text-align:center;z-index:2}
            h1{display:flex;flex-direction:column;align-items:center;margin:0;font:700 ${profile.headline}px/.99 Headline;letter-spacing:-2.4px}
            h1 span:last-child{color:#e6522c}p{display:flex;flex-direction:column;justify-content:center;align-items:center;min-height:${profile.support * 2.4}px;margin:0;font-size:${profile.support}px;line-height:1.2;letter-spacing:-.5px}
            p span{white-space:nowrap}
            .scene{display:flex;flex:1;width:100%;min-height:0;align-items:flex-start;justify-content:center}
            .phone{width:${profile.deviceWidth}px;flex:none;aspect-ratio:1406/2822;position:relative}
            /* Screen and licensed bezel are exact overlapping layers, not flow layout. */
            .screen{position:absolute;left:7.25462%;top:3.543586%;width:85.775249%;height:92.912828%;object-fit:contain;background:#000;mask-image:url('${screenMask}');mask-mode:luminance;mask-size:100% 100%}
            .bezel{position:absolute;inset:0;width:100%;height:100%}
            .tablet{display:block;width:${profile.deviceWidth}px;height:auto;flex:none;border-radius:16px;box-shadow:0 12px 32px #193e3720}
            .desktop-scene{justify-content:flex-start;align-items:center}
            .desktop{display:block;width:${profile.desktopWidth}px;height:auto;flex:none;border-radius:12px;box-shadow:0 18px 30px #193e3725}
        </style></head><body><main><header><h1>${spec.title.map((line) => `<span>${escape(line)}</span>`).join("")}</h1><p>${spec.detail.map((line) => `<span>${escape(line)}</span>`).join("")}</p></header><section class="scene ${desktop ? "desktop-scene" : ""}">${visual}</section></main></body></html>`);
        await page.evaluate(async () => {
            await document.fonts.ready;
            await Promise.all([...document.images].map((image) => image.decode()));
        });
        const geometry = await page.evaluate(({ headline, support }) => {
            const box = (selector) => {
                const rect = document.querySelector(selector)?.getBoundingClientRect();
                return rect
                    ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
                    : null;
            };
            if (!document.fonts.check(`700 ${headline}px Headline`))
                throw new Error("Headline font did not load.");
            if (!document.fonts.check(`400 ${support}px Support`))
                throw new Error("Supporting font did not load.");
            for (const node of document.querySelectorAll("header, h1, h1 span, p, p span")) {
                const rect = node.getBoundingClientRect();
                if (
                    rect.left < 0 ||
                    rect.right > innerWidth ||
                    node.scrollWidth > node.clientWidth + 1
                )
                    throw new Error("Copy overflows.");
            }
            const phone = box(".phone");
            const tablet = box(".tablet");
            const desktop = box(".desktop");
            const device = phone ?? tablet;
            if (
                device &&
                (device.x < 0 ||
                    device.y < 0 ||
                    device.x + device.width > innerWidth ||
                    device.y + device.height > innerHeight)
            ) {
                throw new Error("Device artwork must remain fully visible.");
            }
            if (phone && Math.abs(phone.width / phone.height - 1406 / 2822) > 0.0001)
                throw new Error("Device aspect ratio changed.");
            if (
                desktop &&
                (desktop.x < 0 ||
                    desktop.y < 0 ||
                    desktop.y + desktop.height > innerHeight ||
                    desktop.x + desktop.width <= innerWidth)
            ) {
                throw new Error("Desktop crop must extend only beyond the right edge.");
            }
            return {
                headline: box("h1"),
                phone,
                tablet,
                screen: box(".screen"),
                desktop,
                desktopRightCropPercent: desktop
                    ? (100 * (desktop.x + desktop.width - innerWidth)) / desktop.width
                    : null,
            };
        }, profile);
        const name = `${String(index + 1).padStart(2, "0")}-${spec.id}.png`;
        const bytes = await page.screenshot({ type: "png" });
        const path = join(options.out, name);
        await sharp(bytes)
            .flatten({ background: "#f5f0e7" })
            .toColourspace("srgb")
            .removeAlpha()
            .png()
            .toFile(path);
        const metadata = await sharp(path).metadata();
        if (
            metadata.width !== profile.width * 2 ||
            metadata.height !== profile.height * 2 ||
            metadata.hasAlpha
        )
            throw new Error(`Invalid App Store export ${name}.`);
        report.cards.push({
            file: name,
            ...spec,
            geometry,
            width: metadata.width,
            height: metadata.height,
            hasAlpha: metadata.hasAlpha,
        });
    }
} finally {
    await browser.close();
}
const thumbnails = await Promise.all(
    report.cards.map(async (card, index) => ({
        input: await sharp(join(options.out, card.file)).resize({ width: 220 }).png().toBuffer(),
        left: index * 240 + 20,
        top: 20,
    })),
);
await sharp({
    create: {
        width: 1220,
        height: Math.ceil((220 * profile.height) / profile.width) + 40,
        channels: 3,
        background: "#ddd9d0",
    },
})
    .composite(thumbnails)
    .png()
    .toFile(join(options.out, "contact-sheet.png"));
await writeFile(join(options.out, "composition.json"), JSON.stringify(report, null, 2) + "\n");
console.log(join(options.out, "contact-sheet.png"));
