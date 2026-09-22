# Store screenshot compositions

Five explicit targets belong to this pipeline: iPhone, iPad, Android phone,
Android 7-inch tablet, and Android 10-inch tablet. Apple and Android phone sets
use real device-specific captures and short, legible headlines. Android tablet
sets contain only native UI, without added captions or device art. This is an
output of the integration harness, not a fixture mode in the production app.
Nothing here uploads to App Store Connect or Google Play.

## Story and copy

| Order | Headline                     | Supporting line                                    | Real screen                                                       |
| ----- | ---------------------------- | -------------------------------------------------- | ----------------------------------------------------------------- |
| 1     | Your models. / One place.    | Use existing Claude, / ChatGPT, Grok subscriptions | Native model picker open over a useful conversation               |
| 2     | Every agent. / Within reach. | Follow your work across projects.                  | Populated native session list                                     |
| 3     | From desk / to anywhere.     | Your desktop companion.                            | Actual desktop only, vertically centered and cropped at the right |
| 4     | Build / together.            | You, your team, and your agents.                   | Conversation with recognizable human contributions                |
| 5     | Open source / MIT license    | Read, modify and deploy anywhere                   | Real native file/diff view                                        |

Frame 1 explains model choice, not multimodal input. Do not say AI inference is
free. Do not invent ratings, GitHub stars, testimonials, or unsupported features.
The collaboration frame must prove supported current behavior; a fictional
screenplay is permissible sample content, not evidence of real team login.
Record any identity fixture in the capture manifest and never disguise a
desktop-only capability as an iPhone capability.

## Visual system

Export portrait **1320 × 2868 for iPhone** and **2064 × 2752 for iPad**, sRGB
RGB PNG, no transparency. Cream, deep
green, restrained orange, generous whitespace, two-line benefit headline. Real
dark-mode iPhone screens dominate the composition. No baked playback controls,
debug chrome, notifications, credentials, keyboards obscuring the selling point,
or fake UI cards. Do not add a Happy wordmark/header above the copy. The third
card is desktop-only in both Apple sets and the Android phone set; never overlay
a phone or tablet on it. Android tablet card 3 shows a native overview. Keep
headlines readable in the generated 220px-wide thumbnail contact sheet.

The renderer uses explicit bundled fonts and the 2D Apple device frame credited
in [assets/CREDITS.txt](assets/CREDITS.txt). iPad uses a frameless native capture,
not an invented iPad bezel. Capture at the natural aspect ratio; never stretch.
Use native 1206 × 2622 iPhone captures and native 2064 × 2752 iPad captures.
Both third cards use the actual desktop app-shell capture at 2.5×
(2250 × 2140 pixels), selected explicitly in each manifest. The 832/1080 CSS-pixel
desktop widths intentionally clip only the right edge by about 25.5%/10.4%,
without upscaling. Do not use the tall, mostly empty alternate desktop shot.

## Capture and regenerate

1. Start `happy-mobile-gym` from current mobile main with its explicit run root.
   It supplies only isolated debug startup/auth; create sample history through
   the real local server/Agent APIs, then complete ordinary encrypted pairing.
2. Use a dedicated Simulator, not the developer's active device. Set 9:41,
   full battery, dark mode through Simulator controls. Navigate the actual app
   using accessibility/touch controls. Do not patch its model picker or labels.
3. Save lossless raw screenshots under one ignored capture directory. Keep
   source revision, simulator, capture times, scene purpose, and any scripted
   content/identity boundary in `captures.json`. Capture desktop from the isolated
   current desktop renderer, never the user's installed Electron host.
4. Run the offline composer (requires reviewed browser execution on macOS):

    ```sh
    node scripts/app-store/compose.mjs --captures .context/app-store/captures/iphone/captures.json --out .context/app-store/render/iphone-v2
    node scripts/app-store/compose.mjs --captures .context/app-store/captures/ipad/captures.json --out .context/app-store/render/ipad-v2
    ```

    Use a new output directory each time; existing exports and raw captures are
    never overwritten. Dependencies come from this repository's root
    (`pnpm install`; Playwright 1.61.1 and Sharp); no desktop-gym package is used.
    If Chromium is not installed, install it explicitly with
    `pnpm exec playwright install chromium` before rendering. That is a separate
    tooling installation, never an automatic download during composition.

5. Inspect every full-size PNG and `contact-sheet.png`; check real UI, reading
   order, crop, artifacts, text overflow, no alpha, and thumbnail legibility.
   The capture manifest and `composition.json` retain source hashes and actual
   screen/headline geometry. The source assets remain unchanged.
6. Keep curated raw inputs, intermediate renders, contact sheets, and provenance
   manifests ignored under `.context/`. After selection, track only one final
   five-PNG set per device under `marketing/app-store/en-US/iphone/` and
   `marketing/app-store/en-US/ipad/`. Replace the selected set deliberately;
   remove superseded names such as the version-1 `03-continuity.png` when
   selecting version-2 `03-desktop.png`. Earlier drafts remain in Git history,
   not duplicate tracked output folders.
7. Review copy/visuals with the owner. Upload only with explicit approval and
   confirm the shown features are present in the submitted App Store build.

`captures.json` is explicit, never a filename-discovery heuristic:

```json
{
    "version": 2,
    "device": "iphone",
    "font": "/absolute/path/to/BricolageGrotesque-Bold.ttf",
    "supportFont": "/absolute/path/to/IBMPlexSans-Regular.ttf",
    "provenance": {
        "mobileCommit": "commit hash",
        "desktopCommit": "commit hash",
        "mobileDirty": true,
        "desktopDirty": true,
        "simulator": "dedicated simulator UUID",
        "capturedAt": "ISO timestamp",
        "fixtures": ["Sample conversation and deterministic inference"]
    },
    "screens": {
        "models": "models.png",
        "sessions": "sessions.png",
        "desktop": "desktop-ipad-vtwo.png",
        "multiplayer": "multiplayer.png",
        "source": "diff.png"
    }
}
```

Create a separate manifest with `device: "ipad"` and actual iPad inputs for the
second set. No `continuity` screen is accepted or needed: the five declared
screens are `models`, `sessions`, `desktop`, `multiplayer`, and `source`.
Paths in `screens` are relative to the manifest. The font path is explicit so
the renderer never silently substitutes a host font. This metadata contains no
auth, server master secret, or production account data.

For the model-picker shot, disable the isolated Agent's synthetic `gym` provider
through its normal config API after startup; real catalog providers still route
to the screenplay gateway. Keep permissions on Auto. Capture two useful turns
so the native bottom-aligned conversation is populated; do not move messages
with screenshot CSS. The third card documents the real companion desktop UI;
it does not claim that its desktop-only controls run on iPhone or iPad.

`node --import tsx scripts/app-store/seed-multiplayer.mjs <mobile repository> <mobile gym run root>` supplies the
fictional Alex/Maya/Jamie conversation through normal encrypted APIs. Navigate
to the returned session ID in the current run, not an ID from another run's
database. This demonstrates the native participant-message renderer, **not**
authenticated multi-account sharing, invite flows, or Agent-integrated team
transport. Those require a separate end-to-end verification before publishing
that card. The producer does not impersonate a running CLI version. Keep it
running during capture: it owns a normal session-scoped connection and heartbeat,
so the app correctly shows the conversation as active. Stop it with Ctrl-C after
all captures; it confirms deactivation through the real CLI's archive endpoint,
without deleting the sample history. A failed confirmation reports a nonzero exit.
It never patches the app's archive filter or fabricates Agent metadata.

For the source card, put a short, real public source file into the isolated
registered fixture project, then open the native session's **Changes** screen.
The initial set uses the mobile repository's `sources/utils/sessionListTimestamp.ts`
unchanged. Its normal Git watcher and encrypted file RPC supply the diff; no app
view is drawn or patched. Record the copied file in the fixture disclosure.
Never use a file-view screenshot that exposes a person's absolute host path.

## Android targets and capture contract

Start with [the native Android setup recipe](ANDROID.md) for the debug build,
dedicated devices, private ADB server, gym connection, and cleanup. After that
one-time setup, the checked-in plans in `plans/` replay real UI navigation and
write a fresh capture manifest. Read each plan's `startState` before running it;
close dialogs and restore that state through normal UI. Replace any explicit
session ID with the corresponding session in your current local scenario.
The runner never discovers an account, guesses a session, or patches app state.

For example, after preparing the 10-inch device:

```sh
pnpm screenshots:capture:android run \
 --adb /absolute/path/to/Android/sdk/platform-tools/adb --adb-port 5038 \
 --serial emulator-5584 --avd happy-capture-tablet10-xq29 \
 --target android-tablet-10 --plan scripts/app-store/plans/android-tablet-10.json \
 --out .context/play-store/tablet10-captures
pnpm screenshots:compose \
 --captures .context/play-store/tablet10-captures/captures.json \
 --out .context/play-store/tablet10-render
```

Use the corresponding plan, serial, AVD, and target for the phone and 7-inch
device. The phone additionally requires `--desktop-image /absolute/capture.png`,
`--desktop-commit <actual full source revision>`, and `--desktop-dirty true|false`.
The runner copies that explicit desktop input and generates its manifest;
it does not take or infer a desktop screenshot. Every output directory must be
new. If navigation fails, inspect the actual UI and fix its starting state or
plan before retrying into another fresh directory; partial captures are not a
finished set.

Google Play has separate `phoneScreenshots`, `sevenInchScreenshots`, and
`tenInchScreenshots` destinations. Two design families do not eliminate the two
tablet buckets. Capture both tablet sizes from the real native Android app;
never stretch phone UI into a tablet screenshot or reuse an Apple capture.

| Manifest device     | Native inputs         | Final exports | Third scene |
| ------------------- | --------------------- | ------------- | ----------- |
| `android-phone`     | 1080 × 1920 portrait  | 1080 × 1920   | `desktop`   |
| `android-tablet-7`  | 1920 × 1080 landscape | 1920 × 1080   | `companion` |
| `android-tablet-10` | 1920 × 1080 landscape | 1920 × 1080   | `companion` |

These are explicit capture profiles, not image-shape detection. Configure each
dedicated Android Virtual Device's display before capturing; record its actual
serial, AVD name, API level, and display DPI. The tablet AVDs must represent their
respective physical-size classes with appropriate density and actual responsive
layouts, even though both exports have the same pixel dimensions. Do not resize
an arbitrary capture to pass validation. Use clean native status/navigation bars,
full battery, no personal notifications, and inspect Android permissions and
bottom insets in every scene. Do not change production UI for photography.

Android phone keeps the five headlines above, with a measured caption band of
384 output pixels (20% of the image, including whitespace). The native capture
is scaled down without distortion to 828 × 1472 output pixels, unchanged from
the frameless layout. An original CSS Android-style shell adds a restrained dark
edge, subtly rounded outer corners, and a soft shadow. Its outer corner radius
equals the 16-output-pixel inset, fitting the square native screen corners
without clipping even blank source pixels. The inset lies
entirely outside the native bitmap: the 860 × 1504 shell adds no notch, camera
cutout, screen mask, or UI overlay, and never reads Apple frame assets. The
complete status bar, app, and navigation bar remain visible without source-pixel
upscaling. Its third card uses the actual
desktop capture, vertically centered with only the right side clipped. It is a
**companion-product review draft**, not proof of Android usage or guaranteed
Play acceptance. Replace it with native usage if store review requires it.

Android tablets are full-bleed native UI: no headline, support line, decorative
background, bezel, corner rounding, or shadow. Scene `companion` must be a real
native computer/session overview; a desktop bitmap is not a substitute. The
other scene keys remain `models`, `sessions`, `multiplayer`, and `source`.

The 10-inch plan expands `sessionListTimestamp.ts` in the real Changes route for
the companion card and waits for its diff hunk to load. Its source card uses the
app's normal Zen mode control to focus that same public file without the session
sidebar; the plan restores the sidebar before the multiplayer capture. The
32-line file fits vertically on this tablet, so no artificial scroll, zoom, or
pixel crop is used to distinguish these two cards. Record this native view choice
in the capture manifest's fixture disclosure.

Version 2 now has a closed device-discriminated contract. Existing documented
Apple manifests remain valid and Apple composition geometry is unchanged.
Unknown fields are rejected at every object boundary instead of copied to the
report. Android phone example (replace all example values with actual capture
metadata):

```json
{
    "version": 2,
    "device": "android-phone",
    "font": "/absolute/path/to/BricolageGrotesque-Bold.ttf",
    "supportFont": "/absolute/path/to/IBMPlexSans-Regular.ttf",
    "provenance": {
        "mobileCommit": "1111111111111111111111111111111111111111",
        "desktopCommit": "2222222222222222222222222222222222222222",
        "mobileDirty": false,
        "desktopDirty": false,
        "android": {
            "serial": "emulator-5554",
            "avd": "Happy_Play_Phone",
            "api": 35,
            "dpi": 420
        },
        "capturedAt": "2026-09-21T00:00:00.000Z",
        "fixtures": [
            "Fictional conversation; deterministic inference; participant-author fixture, not verified multi-account sharing"
        ]
    },
    "screens": {
        "models": "models.png",
        "sessions": "sessions.png",
        "desktop": "desktop.png",
        "multiplayer": "multiplayer.png",
        "source": "source.png"
    },
    "altText": {
        "models": "Happy's Android model picker over a conversation.",
        "sessions": "Happy's Android sessions organized across projects.",
        "desktop": "Happy's desktop companion showing an active workspace.",
        "multiplayer": "A Happy conversation showing fictional participant contributions.",
        "source": "A public source file shown in Happy's Android changes view."
    }
}
```

For each tablet manifest, set its explicit device target, remove `font` and
`supportFont`, and remove `desktopCommit` and `desktopDirty` from provenance.
Replace the `desktop` key in **both** `screens` and `altText` with `companion`,
pointing to the real native overview capture and an accurate description.
Record that tablet's actual AVD metadata, rather than copying the phone's DPI.
Apple provenance requires `simulator` instead of `android`; `altText` is Android
input only (Apple reports use the compositor's fixed scene descriptions).

All declared fields are required. Revisions are 40–64 lowercase hexadecimal
characters; dirty flags are booleans. `android.serial` is `emulator-` plus 4–5
digits; `avd` is 1–128 ASCII letters/digits/underscore/dot/hyphen, beginning with
a letter or digit; `api` is an integer 21–100 and `dpi` an integer 72–1000.
`capturedAt` is a parseable timestamp of at most 40 characters. `fixtures` is an
array of at most 20 nonempty descriptions, each at most 512 characters. Every
Android scene requires nonempty, control-character-free alt text of at most
140 Unicode code points. These fields are provenance, not a channel for account
records, environment dumps, passwords, tokens, server URLs, or auth material.

Screens must be single-frame PNG/JPEG ordinary files inside the manifest's
directory, with no symlinks or paths escaping that directory. Native dimensions
are checked exactly; the actual desktop source must also be large enough for
the chosen composition. The composer rejects upscaling, embeds only decoded
raster captures and explicit local fonts, blocks browser network requests, and
never reads Apple device art for an Android target. It checks native-image and
caption geometry, exports opaque sRGB PNGs, and records input dimensions and
SHA-256 hashes, selected target, whitelisted provenance, per-scene alt text,
output dimensions/hashes, and measured geometry in `composition.json`.

Run each capture manifest into a fresh directory:

```sh
node scripts/app-store/compose.mjs --captures .context/app-store/captures/android-phone/captures.json --out .context/app-store/render/android-phone-v1
node scripts/app-store/compose.mjs --captures .context/app-store/captures/android-tablet-7/captures.json --out .context/app-store/render/android-tablet-7-v1
node scripts/app-store/compose.mjs --captures .context/app-store/captures/android-tablet-10/captures.json --out .context/app-store/render/android-tablet-10-v1
```

Inspect all five full-size images and the contact sheet for each device target.
Keep raw captures and manifests ignored. Track only one selected final PNG per
concept and target; do not accumulate alternate drafts in the selected set.
No capture, output selection, upload, or publication is implicit in this command.

## Research basis

- [Apple product page](https://developer.apple.com/app-store/product-page/):
  first one to three screenshots communicate the essence in search results.
- [Apple screenshot specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications/):
  supported dimensions, one to ten images, JPEG/PNG, no transparency.
- [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/):
  2.3.3 permits explanatory text/image overlays but requires actual app usage;
  2.3.7 advises against prices in screenshots; 2.3.10 restricts other mobile
  platform/marketplace promotion. The requested desktop-only third card is a
  companion-product marketing draft, not proof of iOS usage or guaranteed
  acceptance under 2.3.3. Owner/App Review approval is required before publishing
  it as an iOS or iPadOS screenshot; be prepared to replace it with native usage.
- X design discussions informed short headlines and real UI, not numeric
  conversion guarantees. Anecdotal uplift percentages are not product evidence.

- [Google Play preview assets](https://support.google.com/googleplay/android-developer/answer/9866151?hl=en):
  JPEG/24-bit PNG without alpha; general dimensions 320–3840px, longest side at
  most twice the shortest. Screenshot-based app recommendations require at
  least four 9:16 portrait or 16:9 landscape screenshots, with a short side of
  at least 1080px. Large-screen guidance allows 1080–7680px and excludes added
  text outside the core app experience. The chosen Android dimensions satisfy
  both ranges. Necessary phone taglines occupy no more than 20%. The guidance
  prioritizes actual app footage and advises against people interacting with a
  device; this is not a blanket ban on static phone frames. The owner-selected
  Android phone shell is a deliberate presentation choice, not a claim that
  Google endorses frames. Keep tablet exports UI-only and exclude people holding
  devices. Avoid rankings, promotional pricing, and installation calls to action.
  Provide meaningful alt text of at most 140 characters. Five scenes fit the
  maximum of eight per device type. Recheck the live guidance before upload.
- [Google Play image types](https://developers.google.com/android-publisher/api-ref/rest/v3/AppImageType):
  phone, 7-inch tablet, and 10-inch tablet are distinct screenshot buckets.
  The existing 1320 × 2868 Apple exports exceed Play's 2:1 ratio limit and must
  not be reused unchanged.

The iPhone set does not cover iPad submission requirements. The separate iPad
set must contain real 13-inch iPad captures, not scaled iPhone UI. Apple's current
specification page lists 1320 × 2868 for the large iPhone portrait class and
2064 × 2752 for 13-inch iPad portrait; recheck the live specification for the
submitted devices/build before upload. Use PNG/JPEG without alpha and 1–10
screenshots per required device class. Confirm computer/provider subscription
requirements in the listing; the models copy does not promise free inference
or unsupported subscription access. Verify MIT-license claims against the code
being distributed and verify every pictured feature against the submitted
binary. Multiplayer remains a disclosed fixture, not authenticated team-login
evidence, until that separate end-to-end product flow is proven. No upload is
automated.
