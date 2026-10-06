# Native service panel

This package mounts a DOM panel for the SDK service controller. It has no app policy, HTTP client, login system, or provider credentials.

```ts
import { mountServicePanel } from '@wangjs-jacky/paws-connect-ui';
import '@wangjs-jacky/paws-connect-ui/panel.css';

const panel = mountServicePanel(container, {
    controller,
    appearance: {
        title: 'AI 服务',
        showTitle: false, // the host dialog already has a title
        theme: 'auto', // auto | light | dark
        sources: ['platform', 'personal'], // configure both clients first
        ownerManagementUrl: 'https://your-owner-ui.example/authorizations',
    },
    onSourceSelected(source) { /* update the host's settings draft if needed */ },
});
// Unsubscribe and remove the panel. The host still owns the controller.
panel.destroy();
```

Create the controller with `@wangjs-jacky/paws-agent/services/browser`. Pass only the configured sources. The panel does not receive receipts or keys. The host must derive the storage subject from its verified session. On app logout, the host must call `controller.disconnect('logout')`.

The panel hides the source selector when only one source is configured. Set `appearance.showTitle` to `false` when the host supplies a title. The panel keeps its accessible name.

The platform source is shown as the default service. The host prepares it with `controller.restore()`. The panel shows preparation while the connection is pending. A ready connection without a catalog is shown as connected. It is shown as available only when the controller is ready and the catalog reports an online device. Errors and offline catalogs show a reason and a retry action. Retry restores the connection, then reads the catalog. The panel does not start polling. Platform details show the engine, device, and catalog observations. The platform view has no manual connect, disconnect, forget, authorization management, or storage controls.

The initial page has no model questionnaire. Default options follow the service defaults. A native catalog default does not prove the service's configured model or strength. Model settings use explicit model IDs and the selected model's native reasoning values. Opening model settings reads the catalog once if a connection exists and the catalog is missing. The update action remains available for recovery. The panel clears invalid model and reasoning overrides when the catalog changes. The panel does not expose permission choices because controller state does not expose the grant and app permission intersection.

A host can supply a reasoning override without a model override. The panel keeps that value because the configured service model is unknown. Model settings show the current reasoning override as unverified in a disabled field. The panel offers no new reasoning choices until a model is selected. The user can explicitly restore service defaults to clear the override.

Overrides affect new conversations. The controls write overrides to the supplied controller. The host owns any outer settings dialog, draft snapshot, cancel rollback, and commit action. Selecting a source does not create or select a conversation. The host must keep existing conversation bindings. Actual model and reasoning values come from turn records and belong in the host's conversation details. The panel cannot infer these values from the connection or catalog.

A ready connection proves authorization only. The catalog provides the latest observed device availability. The panel maps stable SDK/T1 error codes to recovery messages. It does not change source, account, engine, device, or payer after an error.

Personal authorization shows a web approval link and an SVG QR code. The QR code encodes `pending.qrUrl`; this field is a deep link, not an image URL. Only HTTP(S) approval links and HTTP(S)/Paws QR payloads are accepted. Link targets open in a separate tab without opener access.

For personal services, disconnect pauses the local connection. Forget clears local connection material. Neither revokes the remote grant. Remote revocation belongs to a trusted owner interface. Supply `ownerManagementUrl` to link that interface from the personal view. The panel has no revoke button and makes no revocation claim.

The personal service's optional remember checkbox affects the next connect call. The SDK chooses the storage mode. Personal service details show the current mode. The personal view also shows fallback warnings. It does not claim that inaccessible persistent material has been deleted.

The dialog traps Tab, closes with Escape or a backdrop click, and restores focus to its opening control. Narrow viewports use a bottom sheet. The host can override these CSS variables:

| Variable | Use |
| --- | --- |
| `--paws-service-text` | Text |
| `--paws-service-surface` | Main panel and dialog |
| `--paws-service-inset` | Status and setting summary |
| `--paws-service-control` | Controls |
| `--paws-service-control-hover` | Hover surface |
| `--paws-service-control-hover-text` | Hover text |
| `--paws-service-border` | Borders |
| `--paws-service-focus` | Keyboard focus ring |
| `--paws-service-backdrop` | Modal backdrop |
| `--paws-service-font` | Font shorthand |
| `--paws-service-radius` | Panel corner radius |
| `--paws-service-modal-z` | Modal stacking level |

The defaults use system colors. The QR code uses a light system canvas so its modules remain dark on a light background. Supply semantic host tokens with enough text and focus contrast.

## Public synthetic fixture

Run these commands from this package:

```sh
pnpm build
pnpm fixture:build
python3 -m http.server 4186 --bind 127.0.0.1 --directory fixture-dist
```

Open `http://127.0.0.1:4186/?case=initial`. The fixture uses fake transport data through the real SDK controller. It does not contact a provider. Its controls simulate approval and a catalog change. Use `?case=pending`, `?case=ready`, `?case=reasoning-only`, `?case=limited`, or one of the recovery code names shown in the scenario menu. Add `&theme=dark` for a dark system theme. Storage warnings are simulated status data; they do not test real browser storage denial.

Fixture files are excluded from package exports and packed runtime files. Browser acceptance uses Ego. Real mobile approval and provider availability require separate integration acceptance.
