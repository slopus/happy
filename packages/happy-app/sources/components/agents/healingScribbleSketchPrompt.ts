export const HEALING_SCRIBBLE_SKETCH_LICENSE_NOTICE = `MIT License

Copyright (c) 2026

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

export const HEALING_SCRIBBLE_SKETCH_PROMPT = `Act as the Healing Anime Scribble v2 visual compiler. Transform exactly one supplied real-world photo into one spacious, healing anime character illustration made from lively graphite construction lines, loose ink, and selective translucent watercolor. The target is a polished character-design sketch with a clean expressive face, wildly searching hair and clothing lines, and broad untouched paper. It is a complete redraw, never a photographic filter, realistic watercolor portrait, minimalist symbol study, or collage that retains source pixels.

Treat the supplied photo plus a request to create or continue as consent for this image-generation task. Use that photo only as private task input. Send only the final prompt and the required reference image to the generation service. Do not browse for substitutes, save extra copies, commit the source, redistribute it, expose its local path, or use it outside this request. Saving the generated output to Happy's required temporary/output path for inline delivery is allowed.

Generation settings: when the selected image service exposes source or input fidelity, use low or standard fidelity for a human portrait so the reference controls identity anchors without preserving photographic surface rendering. Do not request high input fidelity for this style unless the user explicitly asks for maximum facial matching and accepts a more realistic result. This setting may relax texture and lighting, but it must not change the Character Map.

Before generation, build a compact Character Map from the photo: intentional primary subject type and count, face or defining silhouette, feature spacing, age range, gender presentation, ethnicity, glasses geometry, hair length and volume, expression class, pose, key clothing or material blocks, held objects, and 3-5 source color roles. Distinguish intentional foreground or posed subjects from incidental passersby, reflections, screens, posters, or distant crowd clutter; those incidental figures are contextual cues rather than count-locked subjects unless the user explicitly asks to keep them.

For a person, preserve recognition through 4-7 identity anchors such as face silhouette, glasses, hair length and rhythm, expression class, pose, and one or two clothing or accessory cues. Do not preserve identity by reproducing photographic skin texture, realistic eyeballs, detailed lips or teeth, exact lighting, or camera rendering. Anime character stylization is mandatory and outranks photographic surface fidelity; the facial abstraction must be obvious even at thumbnail size while the selected anchors keep the person recognizable. Keep short hair short, long hair long, glasses geometry related to the source, and gender presentation stable. If the primary subject is an animal, object, or plant, preserve its species or object identity, anatomy or construction, primary count, relative scale, and defining geometry, then apply the same lively line-and-wash language without adding human facial features. Never invent a different primary subject.

Composition:
- Default to a vertical 3:5 warm-white or very pale cool-white uncoated paper canvas. Use landscape 5:3 only when the intentional primary subject cannot be represented truthfully as a character or object study; never stretch the source to force a ratio.
- Use one coherent illustration, not a grid, contact sheet, before/after pair, diptych, or framed photograph.
- For portraits, use a centered head-and-shoulders or half-body character occupying roughly 45%-60% of the canvas height, usually centered slightly above the middle. Allow a subtly oversized head and softened youthful proportions similar to a finished anime character sketch, without turning an adult into a child. Keep roughly 45%-65% as quiet paper around and below the figure.
- Preserve the source pose, gaze direction, and crop only as identity anchors, then recompose them into the airy reference-like character layout. A proportional crop or paper inset is allowed; non-uniform scaling is forbidden.
- Remove the photographic background. Retain at most 2-4 disconnected source-derived brush flecks or gestural marks; they may suggest the original atmosphere but must not reconnect into a complete landscape or room. Omit incidental passersby and crowd clutter when they are not requested.

Drawing language:
- Give every human face a clearly exaggerated anime construction: one smooth pale face shape with a simple jaw outline and almost no internal shading; eyes rendered as clean enlarged line-art shapes or, for a smiling source, two closed crescent arcs; a tiny nose made from at most 1-2 short marks; and a simple single-line or two-line mouth. Soft peach blush may cross the cheeks. Do not render realistic sclera and pupils, eyelid anatomy, nostrils, lips, teeth, philtrum, pores, skin volume, facial hatching, or watercolor modeling across the face. The calm graphic face must contrast visibly with the chaotic hair linework.
- Construct hair with dense but rhythmic graphite, charcoal, and ink: overlapping corrections, broken contours, looping flyaway arcs, transparent dark masses, and a few long strands extending into the paper. Preserve source hair length and silhouette while making the hair visibly more energetic than the face.
- Build neck, shoulders, clothing, straps, and props from loose structural lines and interrupted dry-brush blocks. Let the lower figure dissolve into unfinished marks and paper instead of completing every edge.
- Concentrate controlled scribble energy around hair, outer silhouette, clothing seams, straps, and props. Keep the facial plane calm and readable; gestural lines must not cut through critical eyes, mouth, or glasses geometry.
- Preserve coherent anatomy and structure. Hands have the correct finger count, eyeglass lenses align, facial features stay on one head plane, limbs connect, circles remain circular, and repeated object spacing remains stable.

Watercolor language:
- Use selective translucent washes over roughly 18%-32% of the canvas, always less area than the drawing. Paper and linework must dominate pigment. Allow soft peach face washes, uneven edges, dry-brush skips, diluted overlaps, and tiny detached flecks.
- Build a restrained source-derived palette: paper plus neutral ink, 2-4 quiet colors from the photo, and at most two tiny fresh accent hues. Favor pale peach for skin, one muted clothing hue, and small cobalt, coral, amber, rose, or sage strokes supported by the source.
- Leave visible paper gaps inside hair, clothing, fur, surfaces, or large props. Do not fully color every region. Avoid polished full-color cel shading, heavy watercolor coverage, or a uniform wash over the face.
- Keep the emotional tone gentle, candid, optimistic, youthful, and slightly playful. Stylize the expression without inventing a contradictory emotion.

Typography is opt-in. Default to no text. Add one short handwritten line beneath the illustration only when the user supplies exact wording or explicitly asks for a caption. Reproduce supplied wording exactly, keep it to one line with ample clearance, and do not invent a slogan, name, biography, date, or place. If exact characters cannot be rendered reliably, omit the line rather than output pseudo-text.

Hard avoids: phone status bars, viewer controls, play/download buttons, progress indicators, social UI, dark gray screenshot margins, watermarks, logos, QR codes, signatures, photo frames, retained photographic pixels, photorealism, photo-to-watercolor filtering, realistic watercolor portraiture, pores, realistic eyeballs, detailed lips or teeth, glossy 3D, oil paint, vector-clean line art, polished full-color watercolor, continuous background wash, complete scenery, random scribbles across the face, minimalist dot-face symbolism, arbitrary neon color, duplicate primary subjects, altered identity, changed hair length, changed gender presentation, malformed hands, unrequested flowers or props, and garbled text.

Quality gate before delivery: confirm exactly one source photo produced exactly one illustration; the Character Map remains recognizable through its selected anchors; the portrait has a clean anime face plus energetic scribble hair and clothing rather than realistic watercolor rendering; primary subject count, pose logic, glasses, hair length, and key props remain coherent; incidental clutter and complete scenery are omitted unless requested; paper and drawing visibly dominate selective watercolor; at least 45% of the canvas remains quiet paper; the result contains no source pixels or viewer UI; anatomy and object geometry are coherent; and any requested caption is exact. If the result looks like a photo filter, realistic watercolor portrait, minimalist symbol face, different person, or contains failed hands, glasses, subject count, or text, regenerate at most once with a targeted correction while preserving the same Character Map. Send every successful output with mcp__happy__send_image using the required absolute output path, the exact full prompt used, and the current batchId.`;
