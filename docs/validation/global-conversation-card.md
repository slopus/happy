# Desktop global conversation card

User-approved scope: add a global conversation card at the beginning of the task grid, using the same dimensions with a subtly different icon, tint, and glare. Reuse the existing global conversation action.

Implementation:
- A desktop web component renders the global card before filtered tasks in both the feature catalog and the open-task catalog.
- Card width/minimum height match task cards (248 / 230); desktop CSS Grid equalizes implicit rows across wrapped and single-column layouts.
- The card uses the shared GoalBoardCard/GoalBoardButton surfaces for hover, selection, focus and keyboard activation. Tint, border and sweep consume the active theme's semantic colors.
- A CSS sweep supplies the decorative glare; prefers-reduced-motion disables its animation. It does not indicate execution status or add status polling.
- Task counts and filters continue to operate only on real tasks. Mobile navigation remains on its existing entry points.
- Activation reuses openGlobalConversation, including history selection, offline behavior, in-flight coalescing and stale-navigation guards.

Validation:
- App TypeScript check: passed.
- Existing overview workspace, card button, photo surfaces (including ginghamDark), task selection and running border regression suites: 55 tests passed.
- Web export: passed (5,894 modules), output /tmp/paws-global-card-web. Existing noble/hashes exports fallback warning did not prevent the build.
- Browser acceptance through Ego: passed in the complete isolated App on 2026-11-19. User explicitly requested screenshots.
- Found and fixed single-column mismatch: global card was 248×230 while tasks were 248×239. Desktop task grids now use equal implicit CSS grid rows; 1680-wide and 1280-wide layouts measured every card at 248×239 under Chinese firefly skin.
- Found and fixed confusing task-specific labels in the global empty conversation. Scope-aware labels now identify the global conversation and goal; task defaults remain unchanged.
- Verified mouse activation, keyboard Enter, task-to-global navigation, existing global conversation reuse and unsent draft retention. One fixture conversation created; zero model submissions and received model messages.
- Verified actual moving sweep and reduced-motion behavior (animation none / opacity 0). Checked Gingham dark hover and keyboard focus colors, then restored the firefly skin for final screenshots.
- Latest typecheck passed; 44 related regression tests passed after both fixes; final Web export passed at /tmp/paws-global-card-web-verified.
- Final verified screenshots were reported to Happy Skills. An early screenshot helper restored the full browser size after a 1280 assertion; superseded by a capture that reapplied and checked the 1280 viewport inside the helper before capture.
- Browser fixtures are synthetic, with actual relay/RPC but a stub session launcher. These checks do not prove production deployment or model startup.
- Detailed runtime assertions: packages/happy-app/test-results/project-goals/global-card-results.json (ignored).
- Source release and automatic Web/OTA deployment are tracked by the corresponding Release OPS local record; browser checks above apply to the isolated candidate.

Browser knowledge was updated at ego-ops/references/sites/paws/operations/verify-global-conversation-card.md and its site indexes; validation completed before the browser space was closed.

Review screenshots: [firefly](global-conversation-card/firefly-global-conversation.png), [1280-wide Gingham](global-conversation-card/gingham-narrow-global-conversation.png).
