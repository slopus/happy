# AI service UI fixture

Run from the repository root:

```sh
node packages/happy-app/e2e/fixtures/ai-services/serve.mjs
```

Open `http://127.0.0.1:49823/?case=consent&theme=dark` with Ego. The controller owns the browser space. This server binds only to localhost. It does not publish a preview.

The fixture mounts the actual ServiceEditor and ServiceConsent components. It also uses AppAuthorizationLayout, AuthorizationChoice, AuthorizationNotice, RoundButton, ItemList, Typography, React Native Web and the current appThemes. `theme=dark` selects `ginghamDark`. `theme=light` selects `caramelLight`.

The fixture replaces the app/auth shell with synthetic props. It simulates owner APIs, accounts, workers and pairing data. The Unistyles adapter evaluates the real style factories against the chosen theme. It does not test the production Unistyles runtime or theme persistence. Layout uses the current Web maximum width of 800. Unused icon rendering is stubbed. It does not load a login provider or contact a server. Synthetic approval does not test encryption, a real grant or native execution. Unit tests cover the real recipient sealing function.

Cases:

- `editor`: select Claude. Its identity comes from the synthetic worker observation. Its quota and native default model are unknown. Choose Model One. Confirm that affected apps need a new authorization before saving. Unverified image capability remains disabled.
- `conflict`: select Model Two and save. The first save returns a revision conflict. Model Two remains selected. Read the latest version, then save again. The request record shows revision 3 followed by revision 4 with the same draft.
- `consent`: select the device/account tuple and default model inline, continue, then inspect the application and permissions. No named service must be created first. Click “检查其他可用目标”. Current Codex stays selected. Claude is available but not selected. Select Claude to add its trusted tuple; the synthetic payload includes both engines on the same machine. The offline device stays disabled. Deselect Claude to return to current-only scope. Images require a separate selection; the synthetic Claude has no verified image support, so the UI requires an explicit compatible permission choice. Compare 1 day, 7 days and until revoked. Browser remembering is separate from the grant lifetime.
- `expired`: the same consent UI has an expired pairing. Approval stays disabled.

Check both themes and narrow/desktop viewports. Test Tab, Space and arrow keys on choices. Confirm that content scrolls and controls remain visible. The fixture request record contains synthetic metadata only.

Generated bundles stay in the temporary fixture directory. Restart the server after component changes. No native, provider, production auth or published-app acceptance is implied.
