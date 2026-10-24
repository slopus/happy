// Writes Stories and Stickers wire samples, each checked against the
// reference TypeScript schemas of @slopus/happy-agent-client
// (`protocol/stories.ts`, `protocol/stickers.ts`), so the Swift port's
// round trip is pinned to them. Also writes the client's own constants and
// `stickerGridColumns` for a range of widths.
//
//   bun scripts/generate-stories-fixtures.ts <happy-agent-client/sources>
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const sources = process.argv[2];
if (!sources) throw new Error("usage: generate-stories-fixtures.ts <happy-agent-client/sources>");
const { Value } = await import(resolve(sources, "../node_modules/@sinclair/typebox/build/cjs/value/index.js"));
const stories = await import(resolve(sources, "protocol/stories.ts"));
const stickers = await import(resolve(sources, "protocol/stickers.ts"));

const transform = (x: number, y: number, scale = 1, rotation = 0) => ({ x, y, scale, rotation });
const frame = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    kind: "image",
    width: 1440,
    height: 900,
    scale: 2,
    thumbhash: "3PcNNYSFeXh/d3eld0iHZoZgVwh2",
    durationMs: null,
    asset: { type: "chat_media", agentId: "a9b8c7d6e5f4g3h2i1j0k9l8", toolCallId: "k8j7h6g5f4d3s2a1q0w9e8r7", index: 0 },
    available: true,
    placement: transform(0.5, 0.5),
    background: ["#1D2B3A", "#4A6A84"],
    overlays: [],
    ...overrides,
});
const story = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    status: "draft",
    authorUserId: "u1x2y3z4a5b6c7d8e9f0g1h2",
    createdBy: { kind: "agent", agentId: "a9b8c7d6e5f4g3h2i1j0k9l8" },
    source: { agentId: "a9b8c7d6e5f4g3h2i1j0k9l8", toolCallId: "c3v5b7n9m1q2w4e6r8t0y2u4" },
    caption: "Login redirect loop: fixed.",
    frames: [frame("f1a2b3c4d5e6f7g8h9i0j1k2")],
    audience: "team",
    artifactVersion: 3,
    createdAt: 1755300000000,
    updatedAt: 1755300500000,
    postedAt: null,
    expiresAt: null,
    seen: false,
    viewCount: null,
    myReaction: null,
    reactions: [],
    version: "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e",
    ...overrides,
});

const everyOverlay = [
    { id: "o1", type: "text", text: "No more loops\nsecond line", style: { font: "sanFrancisco", fill: "filled", color: "#FFFFFF", align: "center", width: 0.8 }, transform: transform(0.5, 0.2) },
    ...stories.storyTextFontSchema.anyOf.map((font: { const: string }, i: number) => ({ id: `t${i}`, type: "text", text: font.const, style: { font: font.const, fill: stories.storyTextFillSchema.anyOf[i % 5].const, color: "#12AB9F", align: ["left", "center", "right"][i % 3], width: 0.1 + i * 0.1 }, transform: transform(0.1 * i, 0.9, 0.05 + i, -Math.PI + i * 0.5) })),
    { id: "o2", type: "link", url: "https://happy.engineering/docs?x=1", label: null, style: "white", transform: transform(0.5, 0.6, 1.2, 0.3) },
    { id: "o3", type: "link", url: "HTTP://example.com", label: "Example", style: "custom", color: "#FF00AA", transform: transform(-0.5, 1.5, 10, Math.PI) },
    { id: "o4", type: "sticker", packId: "utyaduck", stickerId: "AgAD8gADVp29Cg", transform: transform(0.78, 0.8, 0.35, -0.2) },
    { id: "o5", type: "emoji", emoji: "👨‍👩‍👧", transform: transform(0.3, 0.3, 0.2, 0) },
    { id: "o6", type: "reaction", emoji: "❤️", transform: transform(0.5, 0.75, 0.25, 0) },
    { id: "o7", type: "reaction", emoji: "🔥", dark: true, flipped: true, transform: transform(0.2, 0.75, 0.25, 0.1) },
];

const samples = {
    story: [
        story("s7k2m9q4w1e5t8y3u6i0o2p5", { frames: [frame("f1", { overlays: everyOverlay })] }),
        story("s2", {
            status: "posted",
            authorUserId: null,
            createdBy: { kind: "user", userId: null },
            source: null,
            caption: null,
            audience: "self",
            postedAt: 1755300000000,
            expiresAt: 1755386400000,
            seen: true,
            viewCount: 4,
            myReaction: "❤️",
            reactions: [{ emoji: "❤️", count: 3 }, { emoji: "🔥", count: 1 }],
            frames: [
                frame("f2", { kind: "video", width: null, height: null, scale: undefined, thumbhash: null, durationMs: 12000, background: ["#000000", "#000000"] }),
                frame("f3", { asset: { type: "artifact_file", artifactId: "s2", version: 2, path: "media/f3.jpg" }, available: false, placement: transform(0.4, 0.6, 1.5, 0.785) }),
            ],
        }),
        story("s3", { status: "deleted", createdBy: { kind: "user", userId: "u1x2y3z4a5b6c7d8e9f0g1h2" } }),
    ].map((value) => {
        const copy = JSON.parse(JSON.stringify(value));
        if (!Value.Check(stories.storySchema, copy)) throw new Error(`story ${copy.id}: ${[...Value.Errors(stories.storySchema, copy)].map((e: any) => `${e.path} ${e.message}`).join("; ")}`);
        return copy;
    }),
    feed: [
        {
            authors: [
                { userId: "u1", name: "Kirill Dubovitskiy", photo: "/v0/users/u1/photo", thumbhash: "1QcSHQRnh493V4dIh4eXh1h4kJUI", isSelf: true, storyIds: ["s2"], unseenCount: 0, draftCount: 1, latestPostedAt: 1755300000000 },
                { userId: "u9", name: "Steve Korshakov", photo: null, thumbhash: null, isSelf: false, storyIds: ["s4", "s5"], unseenCount: 1, draftCount: null, latestPostedAt: 1755400000000 },
            ],
            stories: { s2: story("s2", { status: "posted", postedAt: 1755300000000, expiresAt: 1755386400000, seen: true, viewCount: 0 }) },
            cursor: "01991f3a-0000-7000-8000-000000000000",
        },
        { authors: [{ userId: null, name: "Me", photo: "/v0/profile/photo", thumbhash: null, isSelf: true, storyIds: [], unseenCount: 0, draftCount: 0, latestPostedAt: null }], stories: {}, cursor: "c" },
    ].map((value) => {
        if (!Value.Check(stories.storyFeedResponseSchema, value)) throw new Error("feed");
        return value;
    }),
    page: [{ stories: [story("s1")], nextCursor: null, cursor: "c1" }, { stories: [], nextCursor: "n", cursor: "c2" }].map((value) => {
        if (!Value.Check(stories.storiesResponseSchema, value)) throw new Error("page");
        return value;
    }),
    media: [
        {
            items: [
                { asset: { type: "chat_media", agentId: "a", toolCallId: "t", index: 0 }, kind: "image", name: "login-fixed.png", width: 1440, height: 900, scale: 2, thumbhash: "3PcNNYSFeXh/d3eld0iHZoZgVwh2", createdAt: 1755300000000 },
                { asset: { type: "artifact_file", artifactId: "r", version: 1, path: "clip.mp4" }, kind: "video", name: "clip.mp4", width: null, height: null, thumbhash: null, createdAt: 1755300000001 },
            ],
            nextCursor: null,
        },
    ].map((value) => {
        if (!Value.Check(stories.storyMediaResponseSchema, value)) throw new Error("media");
        return value;
    }),
    viewers: [
        {
            viewers: [
                { userId: "u9", name: "Steve Korshakov", photo: "/v0/users/u9/photo", thumbhash: null, reaction: "❤️", reactedAt: 1755400000000 },
                { userId: "u8", name: "Ada", photo: null, thumbhash: null, reaction: null, reactedAt: null },
            ],
            nextCursor: null,
        },
    ].map((value) => {
        if (!Value.Check(stories.storyViewersResponseSchema, value)) throw new Error("viewers");
        return value;
    }),
    frameInputs: [
        { id: "f1", upload: { uploadId: "u8p2l4o6a1d3e5f7g9h0j2k4", name: "IMG_0042.jpg" }, overlays: [] },
        { asset: { type: "chat_media", agentId: "a", toolCallId: "t", index: 1 }, overlays: [] },
        { id: "f2", placement: transform(0.5, 0.5, 1.2, 0), background: ["#000000", "#FFFFFF"], overlays: [everyOverlay[0]] },
    ].map((value) => {
        if (!Value.Check(stories.storyFrameInputSchema, value)) throw new Error("frame input");
        return value;
    }),
    pack: [
        { pack: { id: "utyaduck", title: "Duck", kind: "stickers", thumbnail: "AgAD8gADVp29Cg", stickerCount: 2, version: "a34d668493927d74" }, stickers: [
            { packId: "utyaduck", id: "AgAD8gADVp29Cg", emoji: ["😂"], format: "tgs", width: 512, height: 512, size: 5272, sha256: "a34d668493927d74a2b2032a496f7e31f77d47c2e6f3a4e568933950d293e206" },
            { packId: "utyaduck", id: "b-2_x", emoji: [], format: "webm", width: 512, height: 400, size: 1, sha256: "0".repeat(64) },
        ] },
        { pack: { id: "e-1", title: "Shapes", kind: "emoji", thumbnail: "x", stickerCount: 0, version: "v" }, stickers: [] },
    ].map((value) => {
        if (!Value.Check(stickers.stickerPackResponseSchema, value)) throw new Error("pack");
        return value;
    }),
    recents: [{ recents: [{ packId: "utyaduck", stickerId: "AgAD8gADVp29Cg" }], cursor: "c" }, { recents: [] }].map((value) => {
        if (!Value.Check(stickers.stickerRecentsResponseSchema, value)) throw new Error("recents");
        return value;
    }),
};

const widths = [200, 320, 343, 390, 430, 600, 744, 1024];
const constants = {
    canvas: stories.STORY_CANVAS,
    maxFrames: stories.MAX_STORY_FRAMES,
    maxOverlays: stories.MAX_STORY_OVERLAYS,
    maxCaption: stories.MAX_STORY_CAPTION_LENGTH,
    lifetimeMs: stories.STORY_LIFETIME_MS,
    imageDurationMs: stories.STORY_IMAGE_DURATION_MS,
    maxVideoDurationMs: stories.STORY_MAX_VIDEO_DURATION_MS,
    settingKey: stories.STORIES_SETTING_KEY,
    hapticMoments: stories.STORY_HAPTIC_MOMENTS,
    fonts: stories.storyTextFontSchema.anyOf.map((s: { const: string }) => s.const),
    fills: stories.storyTextFillSchema.anyOf.map((s: { const: string }) => s.const),
    linkStyles: stories.storyLinkStyleSchema.anyOf.map((s: { const: string }) => s.const),
    grid: widths.flatMap((width) => [0, 4, 8].flatMap((spacing) => (["stickers", "emoji"] as const).map((kind) => ({ kind, width, spacing, columns: stickers.stickerGridColumns(kind, width, spacing) })))),
};

const out = resolve(import.meta.dir, "../Tests/HappyCoreTests/Fixtures/stories-wire.json");
writeFileSync(out, JSON.stringify({ samples, constants }, null, 1) + "\n");
console.log(`wrote ${out}`);
