# Sidebar organization account-sync evidence

Captured on 2026-08-28 from PR #371 (`fix/sync-sidebar-organization`) against the production account API.

## Reproduction

1. Restore the same production test account in two isolated Ego Light task spaces.
2. In Client A, create the Agent list `SYNC-371 跨端清单` and the tag `SYNC-371 跨端 Tag`.
3. Keep Client B open before the mutation, then open its Lists tab after the account settings update arrives.
4. Verify that Client B displays both records without copying browser storage or re-entering them.

## Evidence

- `client-a-desktop.png`: Client A immediately after creating the list and tag.
- `client-b-desktop.png`: independent Client B after receiving the same account settings. Both desktop captures use the same 2250 x 1406 output size.
- `client-b-mobile.png`: supplemental Client B capture at a 390 x 844 emulated mobile viewport, with the drawer open.

Both screenshots show the same list and tag names. The clients used separate browser task spaces; the shared state arrived through encrypted account settings rather than device-local sidebar settings.
