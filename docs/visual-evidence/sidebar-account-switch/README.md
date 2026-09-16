# Sidebar account switch acceptance

- Base: `a92a1607b8d37f8062899624acf62b4ff1baa298` (account management route without a direct sidebar account list).
- UI implementation: `c991da11`; latest-main integration: `4ff9c829`.
- `gingham-after.png`: 1440×900 Web, Gingham dark theme; selected account surface `rgb(40, 53, 68)`, hovered account surface `rgb(31, 42, 56)`. Captured after selecting the theme through Appearance settings.
- `acceptance.mp4`: 8.1 seconds, 1440×900, H.264/yuv420p. Timestamped UI frames encoded at 30 fps, not native 30 fps capture. Full decode checked. Shows account menu, switching, adding, cancelling and reopening the form.
- Fixtures only: synthetic account identities, local API and no production credentials/history. Neither the video nor screenshot proves real MISS sign-in or native-device reload.
- Additional local checks passed: initial keyboard focus after animation, Escape/trigger focus, 520px window menu bounds, cleared secret after cancelling add.
- Independent code and PC interaction reviews passed. Media also delivered through Happy; playback on the user's device not confirmed.
- A matching before image was not captured; base revision is recorded for reproduction. No claim of complete before/after screenshot coverage.
