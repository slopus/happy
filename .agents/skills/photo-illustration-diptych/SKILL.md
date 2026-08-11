---
name: photo-illustration-diptych
description: Turn one supplied real-world photo into a vertical paper poster that pairs a truthful photographic scene with a composition-matched editorial illustration below it. Use for travel, city, architecture, landscape, heritage, crowd, and night-scene photo-to-illustration comparison posters.
---

# Photo–Illustration Diptych

Create one vertical `3:5` poster from exactly one user-supplied source photo. The poster must read as a deliberate two-part study of the same scene:

- the upper panel is a truthful photographic anchor;
- the lower panel is a simplified illustration that preserves the scene's semantic geometry;
- both panels share the same dominant silhouette, horizon, subject count, relative positions, viewing direction, and visual-weight map.

The source photo is private task input. Use it only for the requested generation, do not browse for substitutes, and do not persist or redistribute it. Happy owns output delivery.

## Visual compiler

Before generation, derive a compact Scene Map: primary subject, secondary anchors, horizon, dominant silhouette, subject count, spatial order, movement direction, native palette, and details that establish identity. Preserve that map in both panels.

Use warm ivory paper, calm margins, one clean photographic rectangle, and a lower illustration field with ample breathing room. The lower panel is an interpretation, not a filter or traced duplicate: simplify architecture and objects by roughly 65–85%, compress foliage, water, crowds, clouds, and texture by roughly 80–95%, and use 4–7 source-derived colors plus neutral ink.

## Framing and proportion safety

Treat the poster canvas ratio, panel allocation, and source-photo ratio as three separate constraints. Apply one uniform scale factor to the source; never stretch or squash it to fill the upper panel. When its aspect ratio differs from the panel, use a proportional crop that keeps the primary subject and identity-bearing anchors, or expose additional warm paper around an inset image. Prefer breathing paper over distorted content.

Build one normalized, content-space Framing Map from the chosen upper crop and reuse it below: subject and landmark centers, relative scale, horizon or ground line, and dominant vertical/horizontal axes. This map is independent of the outer panel bounds. Place the same-aspect-ratio content rectangle inside both panels; when their allocated heights differ, absorb the difference with an independent warm-paper inset instead of stretching either scene. Preserve human and object proportions, including head width-to-height, shoulder-to-torso scale, glasses geometry, wheel and fan circles, repeated hole spacing, and architectural verticals. The illustration may simplify detail, but it must not simplify by changing those ratios. Reject and regenerate once when the panels use different crop windows, a face or body becomes wider or shorter, circles become ovals, or a vertical structure leans without support from the source.

Choose the illustration medium from the source:

- landscape, coast, mountain, or quiet architecture: fine ink contour with sparse diluted watercolor washes;
- heritage, village, mill, trees, or a walking crowd: flat editorial cut-paper shapes with restrained outlines;
- modern skyline or dusk city: geometric vector blocks with a source-derived twilight palette;
- dramatic night architecture or castle-like silhouettes: restrained Art Deco geometry in black, burgundy, copper, and warm stone.

Default to no typography. Add a caption only when the user supplies or explicitly requests exact wording; reproduce that wording exactly, keep it short, and never invent a place name. Never include phone UI, viewer controls, progress bars, watermarks, logos, QR codes, or fake signatures.

Inspect the result before delivery. Reject output if the two panels depict different scenes, landmark count/order drifts, the crop windows or proportions diverge, the lower half becomes a generic filter, the source photo is heavily restyled, text is garbled, people are malformed, or the composition loses the calm paper-poster hierarchy. Regenerate at most once with a targeted correction.
