# Browser completion notifications

## Scope

Opt-in browser system notifications for newly completed task turns while Paws Web remains open and connected, including background tabs. No closed-page Web Push, failed/approval/question notifications, or native notification behavior changes.

Settings → Sound & notifications now includes a separate notification switch, permission recovery guidance and a test notification action. Sound settings remain independent. Clicking a task notification focuses the window and navigates to the session. A successful browser API call cannot prove that macOS displayed a banner (OS permissions and Focus still apply).

## Implementation and review

- Web implementation behind platform-specific module/component; native counterparts are no-ops.
- Browser permission is requested only in the switch's user gesture. Unsupported/insecure contexts and denied permissions are explained; focusing the page refreshes permission status.
- Observe newly persisted completed outcomes (status, turn ID, timestamp), not presentation-state changes. Ignore initial hydration and idle-shell outcome hydration. Readiness events, failure, presence and thinking changes do not masquerade as completion.
- Bound in-memory/storage claims to 300 outcomes. Web Locks serialize cross-tab claims; browsers without Web Locks use best-effort shared storage claims and stable notification tags.
- Independent review identified stale-completion-on-disconnect and missed-completion-on-reconnect cases. Both were corrected and the follow-up review passed.

## Validation

- `pnpm --filter happy-app exec vitest run sources/components/BrowserNotificationSettings.test.tsx sources/sync/webCompletionNotifications.test.ts sources/sync/webSoundAlerts.test.ts sources/sync/localSettings.test.ts`: 60 passed.
- `pnpm --filter happy-app exec tsc --noEmit`: passed.
- Component tests cover explicit permission grant/denial, disabling, test notification and permission refresh/listener cleanup. Notification tests cover real durable outcome structures, hydration, reconnect/disconnect, click navigation, duplicates, cross-tab locking, blocked storage and unavailable APIs.
- Screenshots were asked about; no response yet, so no screenshot environment or capture was started. No real-browser/macOS notification delivery acceptance claimed.
- Shared local settings and entry wiring may conservatively trigger the existing production OTA classifier; notification delivery itself remains Web-only. Deployment evidence is recorded separately after CI.
