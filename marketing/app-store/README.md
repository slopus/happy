# App Store screenshots

One selected five-image set per device, in display order:

- [iPhone](en-US/iphone/): 1320 × 2868.
- [iPad](en-US/ipad/): 2064 × 2752, captured on a real 13-inch iPad Simulator.

Both sets use sRGB RGB PNGs without transparency or source-pixel upscaling.
These dimensions match [Apple's current screenshot specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications/).
The iPad images use the app's native split view, not enlarged iPhone screenshots.
The third card shows only the actual desktop companion, enlarged and cropped on
the right (25.48% of its width on iPhone, 10.37% on iPad).

## Regenerate

The capture/composition instructions and fixture boundaries live in
[scripts/app-store/README.md](../../scripts/app-store/README.md).
The generator, licensed frame assets, and selected output belong to this mobile
repository. Desktop recording tools remain in `happy-desktop`. Nothing in this
marketing directory is imported by the production app, and no store upload is
automated. Raw captures, contact sheets and intermediate variants stay ignored
under `.context/app-store/`; only five selected PNGs per device are tracked.

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