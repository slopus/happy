# App Store screenshots

Selected five-image sets, in display order:

- [iPhone — 6.5-inch upload slot](en-US/iphone-6.5-inch-1284x2778/): **1284 × 2778**. Drag all five PNGs in this folder into the 6.5-inch slot. The folder contains only the upload images.
- [iPhone — 6.9-inch upload slot](en-US/iphone/): 1320 × 2868, the original selected compositions.
- [iPad — 13-inch upload slot](en-US/ipad/): 2064 × 2752, captured on a real 13-inch iPad Simulator.

All sets use sRGB RGB PNGs without transparency or source-pixel upscaling.
Checked against [Apple's current screenshot specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications/)
on 2026-10-02. Upload dimensions are specific to each slot: 1320 × 2868 is
accepted in the 6.9-inch slot, while the 6.5-inch slot accepts 1284 × 2778 or
1242 × 2688 in portrait. The 6.5-inch exports preserve the complete original
compositions with a proportional downscale and 2–3 pixels of matching cream
background at the sides. No app content is edited or cropped by this export.
The iPad images use the app's native split view, not enlarged iPhone screenshots.
The third card shows only the actual desktop companion, enlarged and cropped on
the right (25.48% of its width on iPhone, 10.37% on iPad).

## Regenerate

The capture/composition instructions and fixture boundaries live in
[scripts/app-store/README.md](../../../../scripts/app-store/README.md).
The generator, licensed frame assets, and selected output belong to this mobile
repository. Desktop recording tools remain in `happy-desktop`. Nothing in this
marketing directory is imported by the production app, and no store upload is
automated. Raw captures, contact sheets and intermediate variants stay ignored
under `.context/app-store/`; only five selected PNGs per upload slot are tracked.

Regenerate the 6.5-inch upload set from the selected originals with
`python3 scripts/app-store/export-iphone-65.py` (requires Pillow). The exporter
requires a fresh output directory; use `--out <new-folder>` for another export.
It writes only five ordered PNGs and verifies dimensions, RGB mode, opacity and
the embedded sRGB profile.

The original iPhone drafts were committed first in `de9a180b`; earlier versions
remain recoverable through Git history rather than duplicate output folders.

## Review before uploading

These are review drafts, not approved App Store assets. The native captures use
an isolated debug integration harness, fictional projects, and scripted Agent
responses delivered through the normal encrypted integration. Production UI is
not patched. Auto permissions remain selected. The source card shows a real
public source file through the native diff viewer.

The multiplayer card supplies fictional participant messages through the real
encrypted API. It demonstrates author rendering, not authenticated multi-account
login or team sharing. Verify that complete flow in the submitted build before
publishing the claim. The desktop-only companion card also needs explicit review
against App Review 2.3.3's actual-app-usage requirement; a correctly sized export
does not guarantee acceptance. Confirm subscription and MIT-license wording
against the product actually submitted.