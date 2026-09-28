# DreamSkin implementation asset provenance

The implementation uses the palette and photograph from the reviewed DreamSkin `cecilylove002` ZIP. Run `node packages/happy-app/scripts/inspect-dreamskin-theme.mjs /absolute/path/original.zip` to verify the exact ZIP, its manifest, and the checked-in semantic token mapping; `--write` regenerates that mapping for review. The source CSS is a single `[data-ds-part="root"]` background rule and is never injected into Paws.

The source package is ["休闲室内居家" by cecilylove](https://www.dreamskin.cc/themes/ver_34a73ec14a33630c2578), version 0.1.0. Its manifest declares `CC BY-NC 4.0` and records the image provenance as 「哲风壁纸」. The package SHA-256 is `3ade08bd0066142f1e97f684f28071dd3fa3a356fe65cf1f397e87f779c633e7`. Its `background.jpg` is 3840 × 2160, 884,646 bytes, SHA-256 `81ecf0ebe490d899ff53d69ae7d32c2e4481f7febacf78e86f7ad91e5e275a28`. The user approved using this exact photograph on the independent Paws Web test site and explicitly requested merging and production Web release on 2026-09-28. The underlying photographer's redistribution rights were not independently verified; do not infer rights for other uses from the package label alone.

The served `background.c3c07e0cc5cb266a.webp` is a quality-92 WebP encoding of the package JPEG. Its SHA-256 is `c3c07e0cc5cb266ae6b3aea041891a18839b068e9d91c43b27f3d9f511ee0799` and its size is 324,074 bytes. This replaces the independently generated GPT Image photograph used in the earlier Paws draft.

The local skin is opt-in on PC Web and does not alter public-share theme packs. Turning it off restores the saved Paws color pack and light/dark preference.
