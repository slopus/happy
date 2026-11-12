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

## The first screens' art

Three more files draw the first screen's slides and the screen after it
(`StartGalleryView`, `InstallDesktopViewController`):

| File                 | SHA-256                                                            | Where from |
| -------------------- | ------------------------------------------------------------------ | ---------- |
| `alien-monster.json` | `e0875ef4ae4aa214a3d9de567ea39e9429465addabc91d177ea883302146ae89` | happy-desktop's, as above (its welcome deck's "Natively multiplayer"); MIT, Happy Coder Contributors |
| `llama.json`         | `ff16ee4b8a19a782b5e5b12dbe103d145410f16b8801af5723b6636c56a0a0ff` | happy-desktop's, as above (its welcome deck's "One harness. Every agent."), supplied by its owner; upstream unrecorded there |
| `tv.json`            | `3aad5efeefedef3fcbb2020a12873a40866141ec898a05f7eb67f15482f765fe` | a 📺 animated sticker supplied by Kirill on 2 November 2026 (`AnimatedSticker.tgs`, a Telegram sticker: gzip of Lottie JSON), decompressed and otherwise unmodified; upstream and licence not recorded |


## Happy Cloud's welcome

Four more of happy-desktop's files draw Happy Cloud's welcome: two of its
slides (`CloudWelcomeViewController`, desktop's `CLOUD_SLIDES` in
`CloudConnectScreen.tsx`) and two of the scenes drifting down its sides
(`SetupDriftView`, desktop's `CLOUD_DRIFT` and `SetupDrift.tsx`), taken from
`packages/happy-desktop-ui/src/assets/animations` at happy-desktop's
`dca9b205`, byte for byte (desktop's own copies are already compact). Desktop's
`PROVENANCE.md` records them as supplied by the project owner on 22 and 26
August 2026 (`cloud-variation.json` on 27 August, `tree.json` on 9
November), upstream and licence not recorded there.
`packages/happy-android/app/src/main/res/raw` ships the same bytes as
`state_closed_lock.json` and `state_open_hands.json`.

| File               | SHA-256                                                            |
| ------------------ | ------------------------------------------------------------------ |
| `closed-lock.json` | `f6087f51de1ccc7dea5cfb9853292bc14271e86e9390a8fbc9514b31b32a0ad8` |
| `open-hands.json`  | `7b5b9d98156057d2fb4cb895f0a462e943942be190dd0a302935e2ef306420b4` |
| `cloud-variation.json` | `4833ea8c714e353818667d8c8e39ce807273e86c79c2d473f2331a00526600aa` |
| `tree.json`        | `cb7c9a130992909adba37c6032799c130fe455cdc5a93e16e50f89c3eaba0eee` |

Desktop loops the drifting scenes; here, as every animated emoji, each
plays once as it fades in and holds its last frame, while the view itself
keeps wandering (AGENTS.md, "Animated emoji never loop").

## `podcast-mic.json`, voice's sheets

Not desktop's, and not under `LICENSE` here. Supplied with the request for
voice's welcome and paywall (`CallSheetViewController`, the `podcastMic`
scene, so `StateSceneTests` holds its hash too) as a Telegram
sticker file, `podcast mic.tgs` (SHA-256
`eaa5af703130fe10ae3535e1d26f0a8b3fb85355d91d696f7359d55effb95ee9`), and
committed as that file gunzipped, byte for byte (SHA-256
`f90db7a207596916bc5c0b22db6e3ca40f2e24008b015bc654ee1aa5ff724284`). Its
author and licence are **not verified**: confirm them before a release
build ships it. Android ships the same bytes as
`packages/happy-android/app/src/main/res/raw/call_podcast_mic.json`
(`CallSheetTest` checks the hash), under the same caveat.

## `boba.json`, Settings' support row

Not desktop's, and not under `LICENSE` here. Supplied with the request for
the Support Happy row under Profile in an agent connection's Settings
(`SupportBobaArt`) and its page (`SupportViewController`) as a Telegram sticker file, `boba.tgs` (SHA-256
`e7d7715c1fb01ab45ca9126653a755a2664d4fe2fb0d6fc5b95e2dbe0d77f638`), and
committed as that file gunzipped, byte for byte (SHA-256
`ce7d0449e69bb1e3eba1d06b158a945da94ccc07953cd9e5c477650341b48ae9`). Its
author and licence are **not verified**: confirm them before a release
build ships it. `packages/happy-android/app/src/main/res/raw/state_boba.json`
is the same bytes.

## `tickets.json`, the empty Artifacts list

Not desktop's, and not under `LICENSE` here. Supplied by Steve on 7 November
2026 for the Artifacts screen with nothing in it (`ArtifactListItems`, the
`tickets` scene) as a Telegram sticker's Lottie JSON, already decompressed
(`tickets.json`, "26_YELLOWTICKET_amp1", 512×512, 60 fps, frames 60–240), and
committed byte for byte (SHA-256
`8715ac66cadbd7cba548b81f7366e190592a7c515811c0df69d65ac8e9db51d4`). Its
`"tgs":1` key stays, as the TV's, boba's and mic's do; Lottie ignores it, and
a play from progress 0 starts at its in-point, frame 60. Its author and
licence are **not verified**: confirm them before a release build ships it.
Android ships the same bytes for its empty Artifacts list.

## `clapper-board.json`, new work's Task

Not desktop's, and not under `LICENSE` here. Supplied by Kirill on 11
November 2026 for new work's Task (`NewWorkPanel`, the `clapperBoard` scene;
a bot stands under the robot) as a Telegram sticker file,
`action for tasks.tgs` (SHA-256
`764ae6522784fb6ed9dcc7a40674216b79f11756046e2fc625f3df03c84868ad`), and
committed as that file gunzipped, byte for byte ("Clapper Board", 512×512,
60 fps, frames 0–151; SHA-256
`321f9dfe9e03985a6da6168300fcea7f1d9f886bc111c38fd78043f4fc2244ae`). Its
`"tgs":1` key stays, as the other stickers' do. Its author and licence are
**not verified**: confirm them before a release build ships it.
`packages/happy-android/app/src/main/res/raw/state_clapper_board.json` is the
same bytes.

## `record-bin.json`, a cancelled recording

Not desktop's, and not under `LICENSE` here. Telegram-iOS's
`submodules/TelegramUI/Resources/Animations/BinRed.json` (master, fetched
7 November 2026), committed byte for byte (SHA-256
`17347187deec39d484a45cac4dbc0c016ea7f8b2422cbfd3708968f9d100d1ab`): the
recording's red dot jumping into a bin that closes on it, which
`RecordOverlay` plays where a cancelled recording's dot was, as
`ChatTextInputPanelNode` does. Telegram-iOS is GPL-2.0; adapted with
permission from Steve, as the rest of the microphone is.

## `record-lock.json` and `record-lock-wait.json`, the recording's lock

Not desktop's, and not under `LICENSE` here. Telegram-iOS's
`submodules/TelegramUI/Resources/Animations/Lock.json` (SHA-256
`7f54014258403eae59daad48098be0d221d2c8085500d9461c8d8b7613a1bcd6`) and
`LockWait.json` (SHA-256
`60ce28150af8210c0090f0b37f766e38484fc8e2a7302a31fa3c6863f707c1db`), master,
fetched 7 November 2026 and committed byte for byte: `LockView`'s lock,
bobbing while it waits and closing into stop as the finger slides up, which
`RecordOverlay`'s pill draws as Telegram's does. Telegram-iOS is GPL-2.0;
adapted with permission from Steve, as the rest of the microphone is.
