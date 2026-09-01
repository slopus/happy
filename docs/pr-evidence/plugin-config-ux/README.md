# Plugin configuration UX evidence

## Case 1 — keep a draft and save after a successful connection test

| State | Evidence | Expected result |
| --- | --- | --- |
| Before | `case-1-before.png` | Connection and update actions are below the status/permission content, and testing does not save. |
| Unsaved draft | `case-1-after-draft.png` | DeepSeek values and the multimodal recommendation are visible; the unsaved warning and both actions sit directly below the fields. Placeholder examples are asserted before filling the fields. |
| Saved | `case-1-after-saved.png` | A successful test automatically saves the current configuration, removes the unsaved warning, and keeps success feedback visible. |
| Dark theme | `case-1-after-dark.png` | The saved configuration actions and multimodal guidance remain readable in the `ginghamDark` theme. |

`plugin-config-ux-preview.mp4` is an H.264/yuv420p two-state preview generated from the independently inspected draft and saved screenshots. The executable interaction is covered by the Playwright cases below.

## Verification

- `[PLUGIN-CONNECTION-TEST] 配置草稿跨页面保留且测试成功后自动保存`
- `[PLUGIN-CONNECTION-TEST] 测试失败时不保存并保留草稿`
- Result: `2 passed`
- The success case asserts both the test `POST` and configuration `PUT`.
- The failure case asserts that no configuration `PUT` occurs and that the draft survives reopening the plugin.
