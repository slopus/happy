# Animation provenance

These five files are **happy-desktop's**, from
`packages/happy-desktop-ui/src/assets/animations` at commit `8b133d98e`
(verified byte-identical there and at that repository's `fea51278`). They are
the design system's state pictures, listed and given their meanings in
desktop's `src/LottieScene.tsx`.

They are committed here **compacted**: desktop keeps them pretty-printed, and
re-serialising that JSON with `separators=(',', ':')` and `ensure_ascii=False`
reproduces the SHA-256 its `PROVENANCE.md` records. Nothing was re-exported,
re-drawn or re-timed. `packages/happy-android/app/src/main/res/raw` ships the
same bytes, so the two platforms draw the same files.

| File            | SHA-256                                                            | Meaning (desktop's own words)                               |
| --------------- | ------------------------------------------------------------------ | ----------------------------------------------------------- |
| `snail.json`    | `6a9c7b648681ae9d15b31455a76f7d47c5f53d6d72da10b8e43ba134fbd47a2c` | something is being read right now, and it is taking a moment |
| `wand.json`     | `8de70508fe1ebdeb08fc7005820329696f28ec84adc94f3cc4362cf7d3e72870` | the thing that is missing is one you can make right here     |
| `robot.json`    | `eeabc392ba20328ce97452eb826dddf3e306129e360ce4847c3b48470ffc053b` | an agent is ready to work, and waiting to be told what to do |
| `sparkles.json` | `b14e504ce3467a6ba1c519348dee9fc4e05286b9e4f058f33df9175865bde4b9` | the absence is the good outcome; there is nothing left to do |
| `owl.json`      | `95402270d116a310aa4b1606f88a2bbc79d2b4d947b5d84181c0b126c7aaba59` | we are looking, and there is nothing found yet (search)      |

`StateSceneTests` asserts these hashes, so a file that is replaced or
re-exported fails the build rather than changing the art quietly.

Errors, offline, and small inline tiles deliberately get **no** picture, on
desktop and here: a glyph at most.

`LICENSE` beside this file is the animations' own, and travels with them: they
came from the Happy Coder app (https://github.com/slopus/happy), MIT,
Copyright (c) 2024 Happy Coder Contributors — a different copyright holder from
happy-desktop, whose licence requires the notice to travel.
