# Google Play screenshot review drafts

One selected five-image set per upload target:

- [Phone](en-US/phone/): 1080 × 1920 portrait, with short captions and an Android-style frame.
- [7-inch tablet](en-US/tablet-7/): 1920 × 1080 landscape, native UI only.
- [10-inch tablet](en-US/tablet-10/): 1920 × 1080 landscape, native UI only.

These are two design families but three Google Play upload buckets. All exports
are opaque sRGB RGB PNGs. Tablet images come from separate dedicated Android
devices at different logical densities; none reuse Apple captures, device art,
or stretched phone UI. Five images per target fit Play's eight-image limit.

## Reproduce

See [native setup](../../scripts/app-store/ANDROID.md) and
[capture/composition instructions](../../scripts/app-store/README.md).
The explicit navigation plans live in `scripts/app-store/plans/`. After the
local native setup and scenario are ready, run the matching capture plan, then
`pnpm screenshots:compose` with its generated manifest and a fresh output path.
Keep raw captures, debug bundles, account data, and intermediate renders ignored.
Select only one PNG per concept/target here. No upload or OTA is automated.

The tablet retakes use mobile source `fc1ce7d` plus the responsive-layout changes
in this commit. Phone compositions preserve the earlier verified native captures
and add only the external frame; the unchanged desktop card uses renderer source
`7b63dd676b8f17ae61df4cba03678a19bb767ff0`. The stable Agent 0.4.72 runs in its
isolated capture home. Real Android
API36 development clients use native 1080×1920/420dpi, 1920×1080/288dpi, and
1920×1080/216dpi displays. Private capture manifests retain timestamps, hashes,
source revisions, dimensions, and fixture disclosures.

## Review before store publication

These are **review drafts**, not uploaded or approved store assets. Screenshot
review found timestamp truncation, Android text-surface transparency, and a hidden
small-tablet landscape header. These were fixed in the actual app and the Android
sets retaken. The latest tablet set also uses the real width-aware layout: wide
windows show the sidebar, while narrow windows use one column. Rotation and
keyboard behavior were verified on the native 7-inch target without reloading.
See [the product observations and fixes](../../scripts/app-store/OBSERVATIONS.md).
The capture does not patch app rendering or edit screenshot pixels to conceal bugs.

The isolated debug harness supplies fictional projects and scripted Agent
responses through normal encrypted APIs. Auto permissions remain selected.
The source card shows the public `sessionListTimestamp.ts` through the real
native Git-diff viewer. The tablet companion card shows the real Changes file
expanded beside the sidebar. The source card uses the app's normal Zen control
for a focused view; neither image hides collapsed or unloaded content.

The phone's desktop-only third card is a companion-product marketing draft;
review its acceptability under Play's actual-app-experience guidance. The
fictional multiplayer card verifies participant-author rendering, not real
multi-account team authentication. Verify that complete flow in the submitted
build before publishing the claim. Confirm subscription and MIT-license copy
against the actual submitted product. No ratings, testimonials, or rankings
are fabricated.

## Alt text

Use these descriptions (each under 140 characters):

| File                         | Description                                                              |
| ---------------------------- | ------------------------------------------------------------------------ |
| `01-models.png`              | Happy's Android model picker with OpenAI, Claude and Grok providers.     |
| `02-sessions.png`            | Happy's Android session list organized across projects.                  |
| `03-desktop.png` (phone)     | Happy's desktop companion showing a workspace and conversation.          |
| `03-companion.png` (tablets) | Project changes available through Happy's connected desktop companion.   |
| `04-multiplayer.png`         | A Happy conversation with fictional participant contributions.           |
| `05-source.png`              | A public source file displayed in Happy's native Android changes viewer. |

Recheck [Google Play's current specifications](https://support.google.com/googleplay/android-developer/answer/9866151?hl=en)
before upload: supported dimensions/ratios, device buckets, no transparency,
readability, and the additional requirements for recommendation eligibility.
