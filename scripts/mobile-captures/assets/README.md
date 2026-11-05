Pixel 9 artwork comes from Android Studio's AOSP device-art-resources under
Apache License 2.0. `pixel9/source.json` records upstream Git blob IDs and hashes.
Its back and mask WebPs are unchanged.

Apple iPhone artwork is downloaded separately by `artwork.mjs`; standalone
frames and derived aperture masks are not committed. The iPhone 16 Pro Black
Titanium frame is Apple's 1406×2822 artwork mirrored by
https://github.com/jamesjingyi/mockup-device-frames, pinned to Git blob
`aac753fd235a3efbaa8c6a382659c1701862fa95`. It deliberately frames a native
iPhone capture with compatible screen proportions. Duo Night Sky artwork comes
from https://developer.apple.com/design/resources/#product-bezels; its pinned
DMG, filenames, measured screen apertures and hashes are in `web/duo-artwork.json`.
Apple Design Resources License LYL142 applies. These are mock-ups of native
iOS interfaces and are not affiliated with or endorsed by Apple.

IBM Plex Sans and Mono use the SIL Open Font License 1.1. The renderer uses the
existing native font files; `LICENSE-IBMPlex.txt` is the upstream IBM license
from https://github.com/IBM/plex/blob/master/LICENSE.txt.

The neutral avatar uses the existing Crafted Studios MIT shader placeholder;
its notice and license travel with the fixtures. Task icons and the Kirill
photo are the approved marketing fixture assets.