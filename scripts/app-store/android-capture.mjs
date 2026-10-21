import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { connect } from "node:net";
import { isAbsolute, join, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { validateManifest } from "./profiles.mjs";

// Capture tooling only: real Android UI, an explicitly owned emulator and an
// already-running private adb server. No auth, app state injection, device reset,
// package installation, server startup, or connection to the default adb server.
const { values: args, positionals } = parseArgs({
    allowPositionals: true,
    options: Object.fromEntries(
        [
            "adb",
            "adb-port",
            "serial",
            "avd",
            "target",
            "text",
            "description",
            "point",
            "from",
            "to",
            "path",
            "out",
            "plan",
            "desktop-image",
            "desktop-commit",
            "desktop-dirty",
        ].map((key) => [key, { type: "string" }]),
    ),
});
const [operation] = positionals;
const dimensions = {
    "android-phone": { width: 1080, height: 1920 },
    "android-tablet-7": { width: 1920, height: 1080 },
    "android-tablet-10": { width: 1920, height: 1080 },
};
if (
    positionals.length !== 1 ||
    !["inspect", "tap", "back", "swipe", "route", "capture", "run"].includes(operation) ||
    !isAbsolute(args.adb ?? "") ||
    !/^\d{4,5}$/u.test(args["adb-port"] ?? "") ||
    Number(args["adb-port"]) === 5037 ||
    Number(args["adb-port"]) > 65535 ||
    !/^emulator-\d{4,5}$/u.test(args.serial ?? "") ||
    !/^happy-capture-[a-z0-9-]{1,64}$/u.test(args.avd ?? "") ||
    !Object.hasOwn(dimensions, args.target ?? "")
) {
    throw new Error(
        "Use inspect|tap|back|swipe|route|capture|run --adb /absolute/adb --adb-port <private port, not 5037> --serial emulator-<port> --avd happy-capture-<name> --target android-phone|android-tablet-7|android-tablet-10. run also needs --plan <json> --out <fresh directory>.",
    );
}
if (!(await lstat(args.adb)).isFile()) throw new Error("adb must be an explicit executable file.");
const viewport = dimensions[args.target];
await new Promise((accept, reject) => {
    const socket = connect({ host: "127.0.0.1", port: Number(args["adb-port"]) });
    socket.setTimeout(1500);
    socket.once("connect", () => {
        socket.destroy();
        accept();
    });
    socket.once("error", reject);
    socket.once("timeout", () => {
        socket.destroy();
        reject(new Error("The private adb server is not running; capture will not start one."));
    });
});
const exec = promisify(execFile);
const childEnvironment = Object.fromEntries(
    ["PATH", "TMPDIR", "LANG", "LC_ALL"].flatMap((key) =>
        process.env[key] === undefined ? [] : [[key, process.env[key]]],
    ),
);
// Explicit -H makes adb a remote client even on loopback. Unlike port-only -P,
// it refuses to start a fallback server if our owned server disappears mid-run.
// The client also receives no host HOME or Android auth/config environment.
const adb = async (...command) =>
    (
        await exec(
            args.adb,
            ["-H", "127.0.0.1", "-P", args["adb-port"], "-s", args.serial, ...command],
            {
                env: childEnvironment,
                encoding: "buffer",
                maxBuffer: 32 * 1024 * 1024,
                timeout: 20000,
            },
        )
    ).stdout;
const text = async (...command) => (await adb(...command)).toString("utf8").trim();
if ((await text("get-state")) !== "device") throw new Error("The explicit emulator is not ready.");
if ((await text("shell", "getprop", "ro.kernel.qemu")) !== "1")
    throw new Error("Physical devices are not capture targets.");
const avd = (await text("emu", "avd", "name")).split(/\r?\n/u)[0];
if (avd !== args.avd) throw new Error("Emulator identity differs from the explicit capture AVD.");
const size = await text("shell", "wm", "size");
if (size !== `Physical size: ${viewport.width}x${viewport.height}`)
    throw new Error("Expected native capture dimensions without wm size overrides.");
const api = Number(await text("shell", "getprop", "ro.build.version.sdk"));
const density = /^Physical density: (\d+)$/u.exec(await text("shell", "wm", "density"));
if (!Number.isInteger(api) || !density)
    throw new Error("Expected an explicit native Android API and density without overrides.");
const android = { serial: args.serial, avd, api, dpi: Number(density[1]) };

// Android's external accessibility XML has a fixed node/attribute vocabulary.
// Decode only its ordinary/numeric XML entities; never evaluate markup or DTDs.
function xmlText(value) {
    return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/giu, (_, entity) => {
        const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
        if (Object.hasOwn(named, entity)) return named[entity];
        return String.fromCodePoint(
            Number.parseInt(entity.slice(entity[1] === "x" ? 2 : 1), entity[1] === "x" ? 16 : 10),
        );
    });
}
async function inspect() {
    await adb("shell", "uiautomator", "dump", "/data/local/tmp/happy-capture-ui.xml");
    const xml = await text("exec-out", "cat", "/data/local/tmp/happy-capture-ui.xml");
    if (!xml.includes("<hierarchy") || xml.includes("<!DOCTYPE"))
        throw new Error("Unexpected Android accessibility document.");
    return [...xml.matchAll(/<node\s+([^>]+)>/gu)].map((node) => {
        const attributes = Object.fromEntries(
            [...node[1].matchAll(/([\w-]+)="([^"]*)"/gu)].map((entry) => [
                entry[1],
                xmlText(entry[2]),
            ]),
        );
        return {
            text: attributes.text ?? "",
            description: attributes["content-desc"] ?? "",
            resourceId: attributes["resource-id"] ?? "",
            bounds: attributes.bounds,
            clickable: attributes.clickable === "true",
        };
    });
}
function point(value) {
    const match = /^(\d+),(\d+)$/u.exec(value ?? "");
    if (!match) throw new Error("Coordinates must be explicit x,y integers.");
    const x = Number(match[1]),
        y = Number(match[2]);
    if (x >= viewport.width || y >= viewport.height)
        throw new Error("Point is outside the native display.");
    return [String(x), String(y)];
}
async function select(selector) {
    if (
        !selector ||
        !["text", "description", "resourceId"].includes(selector.field) ||
        typeof selector.value !== "string" ||
        !selector.value
    )
        throw new Error("Use an explicit nonempty accessibility selector.");
    const deadline = Date.now() + 15000;
    while (true) {
        const matches = (await inspect()).filter((node) => node[selector.field] === selector.value);
        if (matches.length > 1)
            throw new Error(`Ambiguous ${selector.field} selector: ${selector.value}`);
        if (matches.length === 1) return matches[0];
        if (Date.now() >= deadline)
            throw new Error(`Native control did not appear: ${selector.value}`);
        await delay(250);
    }
}
async function tap(selector) {
    const node = await select(selector);
    const bounds = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/u.exec(node.bounds ?? "");
    if (!bounds) throw new Error("Native control has no exact bounds.");
    const [, left, top, right, bottom] = bounds.map(Number);
    if (right <= left || bottom <= top) throw new Error("Native control has empty bounds.");
    await adb(
        "shell",
        "input",
        "tap",
        ...point(`${Math.floor((left + right) / 2)},${Math.floor((top + bottom) / 2)}`),
    );
}
async function capture(path) {
    const bytes = await adb("exec-out", "screencap", "-p");
    if (
        !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
        bytes.readUInt32BE(16) !== viewport.width ||
        bytes.readUInt32BE(20) !== viewport.height
    )
        throw new Error("Native capture has invalid PNG dimensions.");
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
    return { file: path, sha256: createHash("sha256").update(bytes).digest("hex"), ...viewport };
}
async function act(step) {
    switch (step.type) {
        case "tap":
            return await tap(step.selector);
        case "point":
            return await adb("shell", "input", "tap", ...point(step.point));
        case "back":
            return await adb("shell", "input", "keyevent", "KEYCODE_BACK");
        case "swipe":
            return await adb(
                "shell",
                "input",
                "swipe",
                ...point(step.from),
                ...point(step.to),
                "600",
            );
        case "wait":
            return await select(step.selector);
        case "settle":
            return await delay(750);
        case "route": {
            // Ordinary authenticated app navigation, never an auth/bootstrap URI.
            // No query, arbitrary scheme, external host, package, or command text.
            if (!/^session\/[a-z][a-z0-9]{19,39}(?:\/changes)?$/u.test(step.path ?? ""))
                throw new Error("Only an explicit session or session-changes route is allowed.");
            return await adb(
                "shell",
                "am",
                "start",
                "-W",
                "-a",
                "android.intent.action.VIEW",
                "-d",
                `happy:///${step.path}`,
                "com.slopus.happy.dev",
            );
        }
        default:
            throw new Error("Unknown native capture action.");
    }
}
if (operation === "inspect")
    console.log(JSON.stringify({ android, viewport, nodes: await inspect() }, null, 2));
if (operation === "tap") {
    if (args.point) await act({ type: "point", point: args.point });
    else
        await tap({
            field: args.description ? "description" : "text",
            value: args.description ?? args.text,
        });
}
if (operation === "back") await act({ type: "back" });
if (operation === "swipe") await act({ type: "swipe", from: args.from, to: args.to });
if (operation === "route") await act({ type: "route", path: args.path });
if (operation === "capture") {
    if (!args.out) throw new Error("capture needs --out <new PNG>.");
    console.log(JSON.stringify({ android, capture: await capture(resolve(args.out)) }));
}
if (operation === "run") {
    if (!args.plan || !args.out)
        throw new Error("run needs --plan <json> --out <fresh directory>.");
    const plan = JSON.parse(await readFile(resolve(args.plan), "utf8"));
    const sceneIds =
        args.target === "android-phone"
            ? ["models", "sessions", "multiplayer", "source"]
            : ["models", "sessions", "companion", "multiplayer", "source"];
    if (
        plan.version !== 1 ||
        plan.target !== args.target ||
        !Array.isArray(plan.scenes) ||
        plan.scenes.length !== sceneIds.length ||
        new Set(plan.scenes.map((scene) => scene.id)).size !== sceneIds.length ||
        plan.scenes.some(
            (scene) =>
                !sceneIds.includes(scene.id) ||
                !Array.isArray(scene.steps) ||
                scene.steps.length > 30,
        )
    )
        throw new Error("Capture plan must declare each native scene once for its exact target.");
    const phone = args.target === "android-phone";
    if (
        phone &&
        (!isAbsolute(args["desktop-image"] ?? "") ||
            !/^[a-f0-9]{40,64}$/u.test(args["desktop-commit"] ?? "") ||
            !["true", "false"].includes(args["desktop-dirty"]))
    )
        throw new Error(
            "Phone run needs explicit --desktop-image, --desktop-commit and --desktop-dirty true|false from the selected desktop capture.",
        );
    if (phone && !(await lstat(args["desktop-image"])).isFile())
        throw new Error("Desktop source must be a regular image, not a symlink.");
    const repository = resolve(import.meta.dirname, "../..");
    const mobileCommit = (
        await exec("git", ["-C", repository, "rev-parse", "HEAD"], { env: childEnvironment })
    ).stdout.trim();
    const mobileDirty =
        (
            await exec("git", ["-C", repository, "status", "--porcelain"], {
                env: childEnvironment,
            })
        ).stdout.trim().length > 0;
    const output = resolve(args.out);
    await mkdir(output, { mode: 0o700 });
    const captured = [];
    for (const scene of plan.scenes) {
        for (const step of scene.steps) await act(step);
        await delay(750);
        const image = await capture(join(output, `${scene.id}.png`));
        captured.push({ ...image, file: `${scene.id}.png`, scene: scene.id });
        console.log(`Captured ${scene.id}`);
    }
    const report = {
        version: 1,
        target: args.target,
        android,
        capturedAt: new Date().toISOString(),
        captures: captured,
    };
    await writeFile(join(output, "native-captures.json"), JSON.stringify(report, null, 2) + "\n", {
        flag: "wx",
        mode: 0o600,
    });
    if (phone)
        await copyFile(args["desktop-image"], join(output, "desktop.png"), constants.COPYFILE_EXCL);
    const descriptions = {
        models: "Happy's Android model picker with OpenAI, Claude and Grok providers.",
        sessions: "Happy's Android session list organized across projects.",
        ...(phone
            ? { desktop: "Happy's desktop companion showing a workspace and conversation." }
            : {
                  companion:
                      "Project changes available through Happy's connected desktop companion.",
              }),
        multiplayer: "A Happy conversation with fictional participant contributions.",
        source: "A public source file displayed in Happy's native Android changes viewer.",
    };
    const manifest = {
        version: 2,
        device: args.target,
        ...(phone
            ? {
                  font: join(
                      repository,
                      "packages/happy-app/sources/assets/fonts/BricolageGrotesque-Bold.ttf",
                  ),
                  supportFont: join(
                      repository,
                      "packages/happy-app/sources/assets/fonts/IBMPlexSans-Regular.ttf",
                  ),
              }
            : {}),
        provenance: {
            mobileCommit,
            mobileDirty,
            android,
            capturedAt: report.capturedAt,
            ...(phone
                ? {
                      desktopCommit: args["desktop-commit"],
                      desktopDirty: args["desktop-dirty"] === "true",
                  }
                : {}),
            fixtures: [
                "Real native Android app on an explicitly owned emulator; debug-only loopback mobile gym startup/auth. No screenshot-only UI patches.",
                "Fictional projects and scripted responses delivered through the isolated real Agent and encrypted mobile integration. Auto permissions; synthetic gym provider disabled through normal settings.",
                "Fictional Alex, Maya and Jamie participant envelopes use the encrypted server API. This proves native author rendering, not authenticated multi-account team sharing.",
                "Source card shows the public mobile utils/sessionListTimestamp.ts through the real native Git diff viewer.",
                ...(phone
                    ? [
                          "The third card is a real desktop companion capture, not Android UI; review before publishing to Google Play.",
                      ]
                    : [
                          "The companion card shows the native project changes view, not a desktop bitmap. Tablet exports contain native UI only.",
                      ]),
            ],
        },
        screens: {
            ...Object.fromEntries(captured.map((image) => [image.scene, image.file])),
            ...(phone ? { desktop: "desktop.png" } : {}),
        },
        altText: descriptions,
    };
    validateManifest(manifest);
    await writeFile(join(output, "captures.json"), JSON.stringify(manifest, null, 2) + "\n", {
        flag: "wx",
        mode: 0o600,
    });
    console.log(join(output, "captures.json"));
}
