"""Build renderer/formats.html: the six-beat iPhone set (renderer/index.html) for every
other store format: iPad, iPhone Duo inner/outer, Android phone, Android 7" and 10" tablets.

CARDS, LOGOS, GITHUB, STARS and the shader are copied verbatim from index.html, so the copy,
palettes, seeds and order can never drift from the approved iPhone set. Only layout and
device presentation are per format.

  formats.html?device=ipad            whole row, for review
  formats.html?device=ipad&export=3   card 3 alone at the window size, for Chrome --screenshot
  &layer=copy|under|frame|mask|desk|dmask   one transparent layer of that card, for the videos
  (the title then holds the screen and desktop rectangles in window pixels)
"""
from pathlib import Path

here = Path(__file__).resolve().parent
src = (here / 'renderer' / 'index.html').read_text()
shared = src[src.index('const CARDS = ['):src.index('const SIZE = {')]
gl_block = src[src.index('const gl = document.createElement("canvas")'):src.index('</script>')]
# Export renders one card: skip the shader for every card that is not shown.
gl_block = gl_block.replace('if (!it.ctx || (it.moving && shown))', 'if (it.el.classList.contains("away")) continue;\n      if (!it.ctx || (it.moving && shown))')
assert 'classList.contains("away")) continue' in gl_block and 'const FRAG' in shared

page = r'''<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  @font-face { font-family: "Plex"; src: url("fonts/IBMPlexSans-SemiBold.ttf") format("truetype"); font-weight: 600; }
  @font-face { font-family: "Plex"; src: url("fonts/IBMPlexSans-Regular.ttf") format("truetype"); font-weight: 400; }
  @font-face { font-family: "PlexMono"; src: url("fonts/IBMPlexMono-Regular.ttf") format("truetype"); font-weight: 400; }
  body { margin: 0; background: #111; }
  .row { display: flex; gap: 14px; padding: 14px; flex-wrap: wrap; align-items: flex-start; }
  .card {
    position: relative; flex: none; width: var(--review-w, 420px); overflow: hidden; border-radius: 18px;
    container-type: inline-size; background: #1b0b3a; aspect-ratio: var(--aspect);
    font-family: "Plex", "IBM Plex Sans", system-ui, sans-serif; color: #fff;
  }
  .card canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
  /* Same type as the iPhone cards: SemiBold title with a soft shadow, Regular subtitle. */
  .copy { position: absolute; left: 5cqw; right: 5cqw; top: var(--copy-top); text-align: center; }
  .copy h2, .copy p { white-space: nowrap; }
  .copy h2 {
    margin: 0; font-weight: 600; font-size: var(--title); line-height: 1.08; letter-spacing: -0.02em;
    text-shadow: 0 0.05em 0.37em rgba(20, 0, 50, .35);
  }
  .copy p {
    margin: calc(var(--title) * .31) 0 0; font-weight: 400; font-size: calc(var(--title) * var(--sub)); line-height: 1.3;
    opacity: .92; text-shadow: 0 0.06em 0.4em rgba(20, 0, 50, .4);
  }
  .card.hero .copy h2 { font-size: calc(var(--title) * var(--hero)); line-height: 1; letter-spacing: -0.035em; }
  .stars {
    display: inline-flex; align-items: center; gap: .4em; margin-top: calc(var(--title) * .3);
    font-size: calc(var(--title) * var(--sub) * .76); opacity: .85; text-shadow: 0 0.08em 0.5em rgba(20, 0, 50, .4);
  }
  .stars i { font-style: normal; display: inline-flex; align-items: center; gap: .26em; margin-left: .26em; }
  .stars svg { width: 1em; height: 1em; fill: currentColor; }
  .stars b { font: 400 .95em "PlexMono", monospace; }
  .copy .logos { display: flex; justify-content: center; align-items: center; gap: calc(var(--title) * .7); margin-top: calc(var(--title) * .5);
    filter: drop-shadow(0 0.3cqw 2cqw rgba(20, 0, 50, .4)); }
  .copy .logos svg { height: calc(var(--title) * .82); width: auto; fill: #fff; }

  .device { position: absolute; left: 50%; top: var(--device-top); width: var(--device-w); transform: translateX(-50%);
    aspect-ratio: var(--device-aspect); filter: drop-shadow(0 2.5cqw 4cqw rgba(16, 0, 48, .5)); }
  .device > img { position: absolute; display: block; }
  .device > .frame, .device > .back { inset: 0; width: 100%; height: 100%; }
  /* Frameless native screens (iPad, Android tablets), rounded like the display. */
  .frameless .screen { inset: 0; width: 100%; height: 100%; border-radius: var(--radius); }
  /* iPhone Duo: Apple Design Resources bezels, the capture masked by the hole's own interior. */
  .duo-inner .screen { left: 3.879728%; top: 5.340454%; width: 92.240543%; height: 89.319092%;
    mask-image: url("frames/inner-screen-mask.png"); mask-mode: luminance; mask-size: 100% 100%; }
  .duo-outer .screen { left: 5.590851%; top: 3.646308%; width: 88.818297%; height: 92.707384%;
    mask-image: url("frames/outer-screen-mask.png"); mask-mode: luminance; mask-size: 100% 100%; }
  /* iPhone 16 Pro, as on the iPhone row of index.html. */
  .iphone .screen { left: 7.25462%; top: 3.543586%; width: 85.775249%; height: 92.912828%; object-fit: contain; background: #000;
    mask-image: url("frames/screen-alpha.png"); mask-mode: luminance; mask-size: 100% 100%; }
  /* Pixel 9, as on the Android phone row of index.html. */
  .android .screen, .android .mask { left: 4.590985%; top: 2.291584%; width: 90.15025%; height: 95.772422%; border-radius: 8.055556% / 3.589109%; }
  /* All platforms: the desktop app where the device would be, running off the right edge. */
  .desktop { position: absolute; left: var(--desk-left); top: var(--device-top); height: var(--desk-h); aspect-ratio: 2266 / 1400;
    border-radius: 1.1cqw; overflow: hidden; box-shadow: 0 2.5cqw 6cqw rgba(16, 0, 48, .5), 0 0 0 .1cqw rgba(255, 255, 255, .12); }
  .desktop img { display: block; width: 100%; height: 100%; }
  /* Play feature graphic: the hero copy on the left, the phone on the right running off the bottom. */
  .side .copy { left: 6cqw; right: auto; top: 50%; transform: translateY(-50%); text-align: left; }
  .side .device { left: 63cqw; transform: none; }
  html.export body { margin: 0; background: none; }
  html.export .row { display: block; padding: 0; }
  html.export .card { border-radius: 0; width: 100vw; }
  html.export .card.away { position: absolute; left: -20000px; top: 0; }
  /* Video layers: each one alone on transparent (mask layers white on black). */
  html.layer .card { background: transparent; }
  html.layer .card canvas { visibility: hidden; }
  html.layer .screen { object-fit: fill; }
  html.layer-copy .device, html.layer-copy .desktop { visibility: hidden; }
  html.layer-under .copy, html.layer-under .desktop, html.layer-under .frame { visibility: hidden; }
  html.layer-under .screen, html.layer-mask .screen, html.layer-dmask .desktop img { content: url("frames/white.png"); }
  html.layer-frame .copy, html.layer-frame .desktop, html.layer-frame .screen { visibility: hidden; }
  html.layer-frame .device { filter: none; }
  html.layer-mask .card, html.layer-dmask .card { background: #000; }
  html.layer-mask .copy, html.layer-mask .desktop, html.layer-mask .frame { visibility: hidden; }
  html.layer-mask .device { filter: none; }
  html.layer-desk .copy, html.layer-desk .device { visibility: hidden; }
  html.layer-dmask .copy, html.layer-dmask .device { visibility: hidden; }
  html.layer-dmask .desktop { box-shadow: none; }
</style>
</head>
<body>
<div class="row on"></div>
<script>
''' + shared + r'''
// Per format. `wide` (landscape) puts each title and subtitle on one line; portrait keeps the
// iPhone's two lines. Sizes are in cqw of the card width. `maxW` caps the device width.
const DEVICES = {
  // The iPhone set's own geometry (index.html), for the portrait video's layers.
  "iphone":    { size: [1320, 2868], wide: false, max: 9,   pFixed: 5, copyTop: 9, gap: 5, bottom: -60, hero: 2.16, maxW: 80,
                 aspect: 1406 / 2822, frame: "frames/iphone-16-pro-black.png", img: "iphone" },
  "ipad":      { size: [2752, 2064], wide: true,  max: 4.4, sub: .6,  copyTop: 3.0, gap: 2.2, bottom: 2.0, hero: 1.8, maxW: 90,
                 frameless: true, aspect: 2752 / 2064, radius: "2.6% / 3.47%", img: "ipad" },
  "duo-inner": { size: [2853, 2007], wide: true,  max: 4.2, sub: .6,  copyTop: 2.6, gap: 2.0, bottom: 1.5, hero: 1.8, maxW: 90,
                 aspect: 3093 / 2247, frame: "frames/duo-inner-marketing.png", img: "duo-inner" },
  "duo-outer": { size: [1398, 2034], wide: false, max: 9,   sub: .6,  copyTop: 7,   gap: 5,   bottom: 4,   hero: 2.16, maxW: 84,
                 aspect: 1574 / 2194, frame: "frames/duo-outer-marketing.png", img: "duo-outer" },
  "android":   { size: [1080, 1920], wide: false, max: 9,   sub: .6,  copyTop: 8,   gap: 5,   bottom: -12, hero: 2.16, maxW: 72,
                 aspect: 1198 / 2531, pixel: true, img: "android" },
  "tablet-7":  { size: [1200, 1920], wide: false, max: 8.4, sub: .6,  copyTop: 8,   gap: 5,   bottom: 5,   hero: 2.16, maxW: 86,
                 frameless: true, aspect: 1200 / 1920, radius: "3.2% / 2%", img: "tablet-7" },
  "tablet-10": { size: [1600, 2560], wide: false, max: 8.4, sub: .6,  copyTop: 8,   gap: 5,   bottom: 5,   hero: 2.16, maxW: 86,
                 frameless: true, aspect: 1600 / 2560, radius: "3.2% / 2%", img: "tablet-10" },
  "feature":   { size: [1024, 500], side: true, title: 6, sub: .6, hero: 2.16, deviceTop: 7, deviceW: 29,
                 aspect: 1198 / 2531, pixel: true, img: "android" },
};
const params = new URLSearchParams(location.search);
const device = params.get("device") || "ipad";
const d = DEVICES[device];
const exportSlot = params.get("export");
if (exportSlot) document.documentElement.classList.add("export");
const layer = params.get("layer");
if (layer) document.documentElement.classList.add("layer", "layer-" + layer);
document.documentElement.style.setProperty("--aspect", `${d.size[0]} / ${d.size[1]}`);
document.documentElement.style.setProperty("--review-w", (d.size[0] > d.size[1] ? 640 : 300) + "px");

const row = document.querySelector(".row");
const items = CARDS.filter((c, n) => !d.side || n === 0).map((c, n) => {
  const el = document.createElement("div");
  el.className = `card ${device}${c.hero ? " hero" : ""}${d.frameless ? " frameless" : ""}${d.pixel ? " android" : ""}${d.side ? " side" : ""}`;
  const title = d.wide && !c.hero ? [c.title.join(" ")] : c.title;
  const lines = d.wide ? [c.lines.join(" ")] : c.lines;
  const screen = `<img class="screen" alt="" src="img-formats/${d.img}/${c.file}.png">`;
  const shown = c.desktop
    ? `<div class="desktop"><img alt="" src="${c.desktop}"></div>`
    : `<div class="device">${d.pixel ? `<img class="back" alt="" src="frames/pixel9-back.webp">${screen}<img class="mask" alt="" src="frames/pixel9-mask.webp">`
        : screen + (d.frame ? `<img class="frame" alt="" src="${d.frame}">` : "")}</div>`;
  el.innerHTML = `<canvas></canvas>
    <div class="copy"><h2>${title.join("<br>")}</h2>${c.logos ? LOGOS : `<p>${lines.join("<br>")}</p>`}${c.hero
      ? `<div class="stars">Free and open source<i>${GITHUB}<b>${STARS}</b></i></div>` : ""}</div>
    ${shown}`;
  row.appendChild(el);
  return { el, canvas: el.querySelector("canvas"), card: c, visible: true, moving: false };
});
if (exportSlot) items.forEach((it, n) => it.el.classList.toggle("away", n !== Number(exportSlot) - 1));

// As on iPhone: one title size for the set (the largest at which every line fits), and one
// device line under the tallest copy block, so swiping the set nothing jumps.
function fit() {
  const cqw = items[0].el.clientWidth / 100;
  if (!cqw) return;
  const set = (k, v) => items.forEach(({ el }) => el.style.setProperty(k, v));
  set("--copy-top", d.copyTop + "cqw"); set("--sub", d.sub); set("--hero", d.hero);
  set("--device-aspect", d.aspect); if (d.radius) set("--radius", d.radius);
  if (d.side) {
    set("--title", d.title + "cqw"); set("--device-top", d.deviceTop + "cqw"); set("--device-w", d.deviceW + "cqw");
    return;
  }
  let size = d.max;
  for (const { el } of items) {
    if (el.classList.contains("hero")) continue;
    const w = el.querySelector(".copy").clientWidth;
    el.style.setProperty("--title", "10cqw");
    for (const t of el.querySelectorAll(d.pFixed ? "h2" : "h2, p")) size = Math.min(size, 10 * w / t.scrollWidth);
    el.style.removeProperty("--title");
  }
  size = Math.floor(size * 10) / 10;
  set("--title", size + "cqw");
  if (d.pFixed) set("--sub", (d.pFixed / size).toFixed(4));
  let bottom = 0;
  for (const { el } of items) {
    const copy = el.querySelector(".copy");
    bottom = Math.max(bottom, (copy.offsetTop + copy.offsetHeight) / cqw);
  }
  const height = items[0].el.clientHeight / cqw;
  const top = bottom + d.gap;
  const width = Math.min(d.maxW, (height - top - d.bottom) * d.aspect);
  set("--device-top", top.toFixed(2) + "cqw");
  set("--device-w", width.toFixed(2) + "cqw");
  // The desktop: as tall as the device on landscape, from the device's left edge; on
  // portrait from 7cqw (as on iPhone), ~2.25 card widths wide, off the right edge.
  const deviceH = width / d.aspect;
  const deskH = d.wide ? Math.min(deviceH, height - top - d.bottom) : Math.min(225 * 1400 / 2266, height - top - 6);
  set("--desk-h", deskH.toFixed(2) + "cqw");
  set("--desk-left", (d.wide ? (100 - width) / 2 : 7).toFixed(2) + "cqw");
}
addEventListener("load", () => document.fonts.ready.then(() => {
  try { fit(); document.title = layer ? JSON.stringify(rects()) : "ready"; } catch (e) { document.title = "error " + e; }
}));
addEventListener("resize", fit);
// Window-pixel rectangles of the screen (card 1) and the desktop (card 6), for the video.
function rects() {
  const rel = (el, card) => { const r = el.getBoundingClientRect(), c = card.getBoundingClientRect();
    return { x: Math.round(r.x - c.x), y: Math.round(r.y - c.y), w: Math.round(r.width), h: Math.round(r.height) }; };
  const one = items[0].el, six = (items[5] || items[0]).el;
  return { screen: rel(one.querySelector(".screen"), one), device: rel(one.querySelector(".device"), one), desk: rel(six.querySelector(".desktop"), six) };
}

''' + gl_block + r'''</script>
</body>
</html>
'''
(here / 'renderer' / 'formats.html').write_text(page)
print('wrote', here / 'renderer' / 'formats.html')
