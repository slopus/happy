/**
 * Adapted from LiamGvchi/gc-minimal-zine-poster (MIT).
 * The original skill is vendored as prompt data so image-style agents on any
 * connected machine can use the capability without a machine-local install.
 */
export const GC_MINIMAL_ZINE_POSTER_PROMPT = `Use the Minimal Zine Poster v0.1 Standard Mode compiler for this style. Treat the user's theme, sentence, object, mood, article idea, content brief, or uploaded photo as the content source. When a photo is attached, preserve its recognizable subject and emotional cue, but reinterpret it as the poster's small paper-bound image anchor rather than reproducing a full-bleed scene.

Compile the result in this exact visual order:
1. Canvas: a tall vertical 3:5 phone poster, full-frame aged matte paper, no border, mockup, frame, or hard paper shadow.
2. Attention geometry: 70%-90% plain paper and one visual cluster occupying about 8%-25% of the canvas. Place it near the center, upper-middle, lower-middle, lower-left, or upper-right, never hugging the edge.
3. Image anchor: reduce the idea to one imageable object, fragment, photo crop, specimen, torn-paper clipping, silhouette, old printed illustration, color block, texture window, or one small conceptual relation.
4. Anchor treatment: bind grayscale photos and paper fragments to the page with torn or softened edges, low-contrast photocopy softness, halftone, scanlines, risograph grain, xerox wear, ink bleed, or slight misregistration. Do not weaken the chosen color anchor.
5. Typography: use sparse small serif, typewriter, or monospaced type; one short readable poetic phrase; optional tiny date, place, weather, or signature; semi-legible microtext or fragmented letters may drift, press against the image edge, blur, or misregister. If the user supplies exact text, keep it short and use it; otherwise invent one short poetic English or Chinese phrase.
6. Color: paper tones and subdued gray/black support exactly one unmistakably saturated opaque ink anchor. Prefer cobalt or ultramarine, rotating when useful through cyan, violet, magenta-pink, lemon yellow, pear green, orange, or tomato red. The color can be the subject, flat silhouette, irregular cutout, substantial block, partial-color photo region, or bold fragmented type. It must occupy roughly 0.8%-2.5% of the canvas or 15%-35% of the visual cluster and remain clearly visible at thumbnail size. Never reduce it automatically to a tiny dot or hairline.
7. Reproduction: flat orthographic scanned-paper appearance, matte absorbent paper, diffuse light, low-to-medium contrast, old-print defects, no hard shadow or 3D depth.
8. Mood: quiet, poetic, nostalgic, sparse, diary-like, archival, distant, memory-like Japanese/Korean indie zine or minimal editorial.

Choose a materially different variation recipe for each generated variant. Select one layout from center-fragment, lower-left-float, upper-right-block, dual-panel, irregular-cutout, type-led, dot-orbit, or single-specimen; one anchor from tiny faded photo, torn-paper clipping, flat silhouette, solid color block, old printed illustration, object specimen, translucent geometric overlay, or abstract texture window; one typography treatment from fragmented floating letters, phrase pressed against an image edge, archive microtext with date/weather, diagonal scattered words, gray ghost text, rough letterpress headline-as-object, text inside a color block, or almost textless tiny caption; one texture from xerox softness, risograph grain, letterpress ink bleed, halftone degradation, film-grain photo, scan noise and paper fibers, aged mottling, or selected soft-motion-blur type; and one mood from quiet, summer, solitude, childhood, seaside, afternoon, night, memory, or slight surrealism.

Before generating, internally compile the final image prompt as four compact sections: canvas/paper/negative space/cluster; subject metaphor/anchor/treatment; typography/exact saturated hue/material form/visual share/print defects; flat-scan mood/avoid list. Make placement, size, text behavior, color, and reproduction process decisive. For an article or complex idea, extract one central imageable metaphor instead of illustrating the whole argument.

Always avoid full-bleed scenes, commercial headline hierarchy, product ads, logo lockups, CTAs, glossy mockups, clean UI white, cinematic lighting, depth of field, 3D, neon, cyberpunk, cute cartoons, kawaii or anime posters, fashion-editorial drama, dense scrapbooks, many colors or objects, stock-photo polish, long clean text blocks, watermarks, QR codes, timestamps, duplicate subjects, or random logos.

Quality gate: the final image must still read as a sparse vertical paper poster at thumbnail scale; 70%-90% must read as paper; the cluster must remain about 8%-25%; there must be one clear visual metaphor, integrated typography and print/scan defects, only one high-chroma hue, and that color anchor must be visibly saturated rather than pale, muted, faded, pastel, or near-monochrome. If the first result loses the color anchor or abandons the paper-poster geometry, tighten those constraints and regenerate once.`;

export const GC_MINIMAL_ZINE_POSTER_LICENSE = `MIT License

Copyright (c) 2026 LiamGvchi

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;
