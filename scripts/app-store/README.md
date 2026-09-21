# App Store screenshot compositions

Two separate five-image sets belong to this Happy repository: iPhone and iPad.
Both use real device-specific captures and short, legible headlines. This is an
output of the integration harness, not a fixture mode in the production app.
Nothing here uploads to App Store Connect.

## Story and copy

| Order | Headline                     | Supporting line                       | Real screen                                            |
| ----- | ---------------------------- | ------------------------------------- | ------------------------------------------------------ |
| 1     | Your models. / One place.    | Use existing Claude, / ChatGPT, Grok subscriptions | Native model picker open over a useful conversation |
| 2     | Every agent. / Within reach. | Follow your work across projects.     | Populated native session list                          |
| 3     | From desk / to anywhere.     | Your desktop companion.              | Actual desktop only, vertically centered and cropped at the right |
| 4     | Build / together.            | You, your team, and your agents.      | Conversation with recognizable human contributions     |
| 5     | Open source / MIT license   | Read, modify and deploy anywhere     | Real native file/diff view                             |

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
card is desktop-only in both sets; never overlay a phone or tablet on it. Keep
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
that card. The producer does not impersonate a running CLI version.

For the source card, put a short, real public source file into the isolated
registered fixture project, then open the native session's **Changes** screen.
The initial set uses the mobile repository's `sources/utils/sessionListTimestamp.ts`
unchanged. Its normal Git watcher and encrypted file RPC supply the diff; no app
view is drawn or patched. Record the copied file in the fixture disclosure.
Never use a file-view screenshot that exposes a person's absolute host path.

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

App Store first. Android dimensions/assets and any store publication are separate
work; do not copy Apple-device art into a Play Store submission.

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
