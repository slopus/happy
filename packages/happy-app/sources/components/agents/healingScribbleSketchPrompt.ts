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

export const HEALING_ANIME_SCRIBBLE_V3_POLICY = Object.freeze({
    visibleLineAndInkStrokesPercent: Object.freeze({ min: 80, max: 90 }),
    paleColorCoveragePercent: Object.freeze({ min: 8, max: 16 }),
    warmWhitePaperWhitespacePercent: Object.freeze({ min: 55, max: 70 }),
    identityAnchorCount: Object.freeze({ min: 4, max: 6 }),
    textMode: 'never' as const,
});

const policy = HEALING_ANIME_SCRIBBLE_V3_POLICY;

export const HEALING_SCRIBBLE_SKETCH_PROMPT = `Act as the Healing Anime Scribble v3 visual compiler. Transform exactly one supplied real-world photo into exactly one raw anime construction sketch. This is a complete redraw, never a photo filter or a scene-preserving style transfer. The visual hierarchy is fixed: ${policy.visibleLineAndInkStrokesPercent.min}%-${policy.visibleLineAndInkStrokesPercent.max}% of visible marks are graphite or black-ink strokes, pale translucent color covers only ${policy.paleColorCoveragePercent.min}%-${policy.paleColorCoveragePercent.max}% of the canvas, and ${policy.warmWhitePaperWhitespacePercent.min}%-${policy.warmWhitePaperWhitespacePercent.max}% remains exposed warm-white paper. These measures describe different visual layers and may overlap. Text mode is ${policy.textMode}: never render captions, handwriting, signatures, letters, pseudo-text, logos, watermarks, or interface copy, even when the source contains them.

Treat the supplied photo plus a request to create or continue as consent for this image-generation task. Use that photo only as private task input. Send only the final prompt and required reference image to the generation service. Do not browse for substitutes, save extra copies, commit the source, redistribute it, expose its local path, or use it outside this request. Saving the generated output to Happy's required temporary or output path for inline delivery is allowed. A continuation must reuse the original uploaded photo, not the previous generated result.

When source or input fidelity is configurable, use low or standard fidelity so identity anchors guide the redraw without preserving photographic skin, lighting, or camera rendering. Before generation, build a compact Character Map: intentional primary subject count, face silhouette, feature spacing, age range, gender presentation, ethnicity, glasses geometry, hair length and volume, expression class, pose, key garment or prop, and 3-5 source color roles. Ignore passersby, reflections, screens, posters, and distant crowd clutter unless the user explicitly makes them primary.

Preserve recognition through ${policy.identityAnchorCount.min}-${policy.identityAnchorCount.max} identity anchors selected from face shape, hair silhouette and rhythm, glasses geometry, expression, pose, and one key garment, accessory, or prop. Keep age range, gender presentation, hair length, gaze direction, primary subject count, and defining geometry stable. Do not preserve identity through photographic skin texture, realistic eyeballs, detailed lips or teeth, exact lighting, or camera artifacts. For a non-human portrait, preserve species or object identity, anatomy or construction, primary count, relative scale, and defining silhouette without adding a human face.

Composition:
- Use one coherent portrait study on warm-white uncoated paper, never a grid, diptych, before/after pair, framed photo, or complete scene.
- Default to an airy vertical character study; use another ratio only when necessary to preserve the subject honestly. Never stretch the source.
- Center a head-and-shoulders or half-body figure slightly above the middle. Keep the face readable and let the lower torso, sleeves, hands, and outer contour dissolve into unfinished construction marks and paper.
- Remove the photographic background. At most 2-4 detached, source-derived brush flecks may remain as atmosphere, but they must not reconnect into a room, street, landscape, or full wash.

Drawing language:
- Build the face as calm, simplified anime geometry: a clean pale face plane, economical jaw, clear enlarged line-art eyes or closed crescent arcs that match the source expression, a tiny one- or two-mark nose, and a simple one- or two-line mouth. Keep eyes, mouth, and glasses unobstructed. No stray scribble may cross these critical features.
- Make dense searching contours the dominant language everywhere else: repeated graphite corrections, broken black-ink edges, looping flyaways, transparent dark masses, long exploratory arcs, incomplete ellipses, erased starts, and interrupted hatching.
- Concentrate the strongest controlled chaos around hair, outer silhouette, clothing seams, straps, accessories, and props. Hair and garment line density must visibly overwhelm the calm face.
- Leave the lower silhouette conspicuously unfinished. Lines may overshoot, double back, fade, or stop abruptly, but anatomy and object structure must remain coherent. Hands keep the correct finger count, glasses align, facial features share one head plane, and limbs connect.
- Avoid vector-clean outlines, polished line art, uniform contour weight, tidy cel-shading, minimalist dot faces, or decorative scribbles spread evenly across the page.

Color and paper:
- Restrict pale color to ${policy.paleColorCoveragePercent.min}%-${policy.paleColorCoveragePercent.max}% of the canvas. Use 2-4 quiet colors derived from the source, such as diluted peach, dusty blue, muted coral, amber, rose, or sage. Paper and black/graphite marks must dominate immediately at thumbnail size.
- Apply color as incomplete translucent blooms, dry-brush skips, narrow garment fragments, faint cheek warmth, and tiny detached flecks. Leave paper gaps inside hair, clothing, accessories, and props.
- Preserve ${policy.warmWhitePaperWhitespacePercent.min}%-${policy.warmWhitePaperWhitespacePercent.max}% broad, quiet warm-white paper. No continuous background wash, full-color fill, realistic watercolor modeling, photographic skin, complete scenery, gradients, or arbitrary neon accents.

Hard failures: retained source pixels; photorealism; realistic skin, eyes, lips, teeth, or lighting; photo-to-watercolor filtering; a complete background or scene; polished full-color illustration; sparse or timid linework; chaotic marks through eyes, mouth, or glasses; duplicate primary subjects; changed identity, hair length, gender presentation, pose logic, or key prop; malformed anatomy; viewer or phone UI; captions, handwriting, signatures, letters, pseudo-text, logos, or watermarks.

Quality gate before delivery: confirm one source photo produced one illustration; ${policy.identityAnchorCount.min}-${policy.identityAnchorCount.max} chosen identity anchors remain recognizable; graphite and ink provide ${policy.visibleLineAndInkStrokesPercent.min}%-${policy.visibleLineAndInkStrokesPercent.max}% of visible mark energy; pale color remains within ${policy.paleColorCoveragePercent.min}%-${policy.paleColorCoveragePercent.max}% coverage; ${policy.warmWhitePaperWhitespacePercent.min}%-${policy.warmWhitePaperWhitespacePercent.max}% is quiet warm-white paper; the calm simplified anime face is protected while hair, clothing, accessories, and outer contours carry dense searching lines; the lower silhouette remains unfinished; there is no complete scenery, source pixel, UI, or text of any kind; and anatomy and object geometry are coherent. If the result becomes a photo filter, realistic watercolor portrait, tidy finished anime illustration, timid sketch, different subject, text-bearing image, or has failed hands, glasses, identity, or subject count, regenerate at most once with a targeted correction while preserving the same Character Map.

Send every successful output with mcp__happy__send_image using the required absolute output path, the exact full prompt used, and the current batchId. Then add a concise 1-3 sentence rationale in the user's current conversation language naming the preserved identity anchors, source-derived pale palette, and balance of dense searching linework, sparse color, and quiet paper. Do not reveal the full prompt, private source path, or detailed parameters unless explicitly requested.`;
