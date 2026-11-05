# Happy i18n

`translations/` holds plain JSON catalogs shared by native iOS and Android.
Each locale has the same flat keys. Values are strings, `{ "t": "…${name}…" }`
templates, or selections with `p` (parameter), `k` (boolean, enum or plural
rule), `c` (cases) and optional `x` (exact-number overrides). `parameters.json`
defines ordered parameter names and kinds (`text`, `number`, `bool` or
`{ "values": […] }`). Keep parameter order stable: Android uses positional
format arguments. The catalogs preserve the retired client's wording and
plural rules without TypeScript or React Native dependencies.

After editing a catalog, run from the repository root (Node 20+):

```sh
node packages/happy-ios/scripts/generate-translations.mjs
node packages/happy-android/tools/translations/generate.mjs
node --test packages/happy-i18n/catalogs.test.mjs
```

Commit the generated native resources and test vectors too. No dependency
installation or TypeScript loader is needed. The Android generator maps the
catalog rules to Android's CLDR quantities and retains exact-count exceptions.

The native apps' checked-in crypto, sending, diff and icon fixtures remain
compatibility baselines. Their old React Native source-based generators
have been retired; historical inputs are available in Git history.