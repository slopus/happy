# F4 window acceptance research

Status: incomplete and unvalidated. `RelayWindowDeviceTest.kt.txt` preserves a draft instrumentation scenario from the Android layout work. It is deliberately outside all source sets and has a `.txt` suffix, so it cannot be mistaken for a passing test or enter an Android build.

The draft uses a real MainActivity/AppGraph with synthetic signed-in accounts and cached messages, and a closed local endpoint. It requires an empty disposable `f4_*` AVD and explicit isolation/source/APK arguments before changing storage or window settings. It sketches 411→900→411dp resizing, activity rotation, selected-account and list-anchor retention, draft retention, and stationary sidebar bounds during navigation.

The scenario was paused for higher-priority composer, Back animation, keyboard and header work. It was never compiled or run. Some selectors target the earlier relay chat (`ComposerTags`, `ChatScreenTags`) and must be reconciled with current routing before use. The draft's fixed resize timing and sampled animation checks also require review against the final app. No F4 acceptance result should be inferred from this file.

Remaining limitation: the full cached relay/tablet transition sequence above has no completed device result from this workstream. Resized windows would not establish physical hinge behavior, live relay transport, process-death restoration or hardware fold posture coverage even after the draft is made runnable.

Current header/IME portrait and wide acceptance was completed separately on exact APK pairs. The per-revision screenshots, instrumentation logs, Telegram navigation research and sanitized ChatGPT reference captures remain in this workspace's ignored `.context/` directory for archival; they are not app source or release artifacts.