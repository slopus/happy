import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, join, sep } from "node:path";
import { validateManifest } from "./profiles.mjs";

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
const { profile, provenance } = validateManifest(manifest);
const androidPhone = manifest.device === "android-phone";

const specs = [
    {
        id: "models",
        title: ["Your models.", "One place."],
        detail: ["Use existing Claude,", "ChatGPT, Grok subscriptions"],
        altText: "Happy's native model picker over a conversation.",
    },
    {
        id: "sessions",
        title: ["Every agent.", "Within reach."],
        detail: ["Follow your work across projects."],
        altText: "Happy sessions organized across projects.",
    },
    {
        id: profile.uiOnly ? "companion" : "desktop",
        title: ["From desk", "to anywhere."],
        detail: ["Your desktop companion."],
        altText: "Happy's desktop companion showing an active workspace.",
    },
    {
        id: "multiplayer",
        title: ["Build", "together."],
        detail: ["You, your team, and your agents."],
        altText: "A Happy conversation showing fictional participant contributions.",
    },
    {
        id: "source",
        title: ["Open source", "MIT license"],
        detail: ["Read, modify and deploy anywhere"],
        altText: "A public source file shown in Happy's native changes view.",
    },
].map((spec) => ({
    ...spec,
    ...(profile.platform === "android" ? { altText: manifest.altText[spec.id] } : {}),
    ...(profile.uiOnly ? { title: [], detail: [] } : {}),
}));
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
    if (!["png", "jpeg"].includes(metadata.format) || (metadata.pages ?? 1) !== 1)
        throw new Error(`${id} must be a single-frame PNG or JPEG capture.`);
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
            : profile.uiOnly
              ? profile.width
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
const font = profile.uiOnly
    ? null
    : data(await readFile(resolve(dirname(options.captures), manifest.font)), "font/ttf");
const supportFont = profile.uiOnly
    ? null
    : data(await readFile(resolve(dirname(options.captures), manifest.supportFont)), "font/ttf");
const frame =
    manifest.device === "iphone"
        ? data(
              await readFile(join(workspace, "scripts/app-store/assets/iphone-16-pro-black.png")),
              "image/png",
          )
        : null;
const screenMask =
    manifest.device === "iphone"
        ? data(
              await readFile(join(workspace, "scripts/app-store/assets/screen-alpha.png")),
              "image/png",
          )
        : null;
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
              : androidPhone
                ? `<div class="android-device"><img class="android-screen" src="${images[spec.id]}" alt=""></div>`
                : `<img class="tablet" src="${images[spec.id]}" alt="">`;
        await page.setContent(
            profile.uiOnly
                ? `<!doctype html><html><head><meta charset="utf-8"><style>
            *{box-sizing:border-box}html,body{margin:0;width:${profile.width}px;height:${profile.height}px;overflow:hidden}
            body{display:flex}img{display:block;width:100%;height:100%;object-fit:contain;flex:none}
        </style></head><body><img class="native" src="${images[spec.id]}" alt="${escape(spec.altText)}"></body></html>`
                : `<!doctype html><html><head><meta charset="utf-8"><style>
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
            ${
                androidPhone
                    ? `
            /* The entire caption band (including its whitespace) is 20% of the export. */
            main{padding:0;gap:0}
            header{height:192px;padding:24px 32px 12px;gap:8px}
            h1{letter-spacing:-1.4px}
            .scene{padding:0 32px}
            /* Original shell, outside the complete native bitmap. Outer radius equals inset so its square screen corners nest cleanly without a mask. */
            .android-device{display:flex;flex:none;width:${profile.deviceWidth + profile.frameInset * 2}px;padding:${profile.frameInset}px;border-radius:${profile.frameInset}px;background:linear-gradient(135deg,#45494e,#202225 24%,#111315 72%,#3c4045);box-shadow:inset 0 0 0 1px #74797e,inset 0 0 0 3px #181a1d,0 5px 10px #193e3726}
            .android-screen{display:block;flex:none;width:${profile.deviceWidth}px;height:auto}
            `
                    : ""
            }
        </style></head><body><main><header><h1>${spec.title.map((line) => `<span>${escape(line)}</span>`).join("")}</h1><p>${spec.detail.map((line) => `<span>${escape(line)}</span>`).join("")}</p></header><section class="scene ${desktop ? "desktop-scene" : ""}">${visual}</section></main></body></html>`,
        );
        await page.evaluate(async () => {
            await document.fonts.ready;
            await Promise.all([...document.images].map((image) => image.decode()));
        });
        const geometry = await page.evaluate((profile) => {
            const { headline, support, platform, uiOnly, rawWidth, rawHeight, frameInset } = profile;
            const box = (selector) => {
                const rect = document.querySelector(selector)?.getBoundingClientRect();
                return rect
                    ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
                    : null;
            };
            if (uiOnly) {
                const native = box(".native");
                if (
                    !native ||
                    native.x !== 0 ||
                    native.y !== 0 ||
                    native.width !== innerWidth ||
                    native.height !== innerHeight
                )
                    throw new Error("Tablet export must contain only a full-size native capture.");
                return { native, captionBandPercent: 0 };
            }
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
            const captionBand = box("header");
            if (platform === "android") {
                const captionBottom = captionBand.y + captionBand.height;
                if (captionBand.y < 0 || captionBottom > innerHeight * 0.2)
                    throw new Error("Android captions must occupy at most 20% of the image.");
                for (const node of document.querySelectorAll("h1, h1 span, p, p span")) {
                    const rect = node.getBoundingClientRect();
                    if (rect.top < captionBand.y || rect.bottom > captionBottom)
                        throw new Error("Android copy escapes the caption band.");
                }
            }
            const phone = box(".phone");
            const androidDevice = box(".android-device");
            const androidScreen = box(".android-screen");
            const tablet = box(".tablet");
            const desktop = box(".desktop");
            const device = phone ?? androidDevice ?? tablet;
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
            if (androidDevice) {
                if (
                    !androidScreen ||
                    Math.abs(androidScreen.width / androidScreen.height - rawWidth / rawHeight) >
                        0.0001 ||
                    androidScreen.width * devicePixelRatio > rawWidth ||
                    androidScreen.height * devicePixelRatio > rawHeight ||
                    androidScreen.x !== androidDevice.x + frameInset ||
                    androidScreen.y !== androidDevice.y + frameInset ||
                    androidDevice.width !== androidScreen.width + frameInset * 2 ||
                    androidDevice.height !== androidScreen.height + frameInset * 2
                )
                    throw new Error(
                        "Android shell must surround the complete native screen without distortion or upscaling.",
                    );
            }
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
                ...(platform === "android"
                    ? {
                          captionBand,
                          captionBandPercent:
                              (100 * (captionBand.y + captionBand.height)) / innerHeight,
                      }
                    : {}),
                headline: box("h1"),
                phone,
                ...(platform === "android" ? { androidDevice, androidScreen } : {}),
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
            throw new Error(`Invalid store export ${name}.`);
        report.cards.push({
            file: name,
            ...spec,
            geometry,
            width: metadata.width,
            height: metadata.height,
            hasAlpha: metadata.hasAlpha,
            sha256: createHash("sha256")
                .update(await readFile(path))
                .digest("hex"),
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
