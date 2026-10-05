# Native service panel

This package mounts a DOM panel for the SDK service controller. It has no app policy, HTTP client, login system, or provider credentials.

```ts
import { mountServicePanel } from '@wangjs-jacky/paws-connect-ui';
import '@wangjs-jacky/paws-connect-ui/panel.css';

const panel = mountServicePanel(container, {
    controller,
    appearance: {
        title: 'AI 服务',
        theme: 'auto', // auto | light | dark
        sources: ['platform', 'personal'], // configure both clients first
        ownerManagementUrl: 'https://your-owner-ui.example/authorizations',
    },
    onSourceSelected(source) { /* update host UI if needed */ },
});
// Unsubscribe and remove the panel. The host still owns the controller.
panel.destroy();
```

Create the controller with `@wangjs-jacky/paws-agent/services/browser`. Pass only the configured sources. The panel does not receive receipts or keys. The host must derive the storage subject from its verified session. On app logout, the host must call `controller.disconnect('logout')`.

The initial page has no model questionnaire. Default options follow the service defaults. A native catalog default does not prove the service's configured model or strength. Advanced settings use explicit model IDs and the selected model's native reasoning values. The panel clears invalid model and reasoning overrides when the catalog changes. The panel does not expose permission choices because controller state does not expose the grant and app permission intersection.

Overrides affect new conversations. The host must keep existing conversation bindings. Actual model and reasoning values come from turn records. The panel cannot infer these values from the connection or catalog.

A ready connection proves authorization only. Use the check action to read live capabilities. The panel maps stable SDK/T1 error codes to recovery messages. It does not change source, account, engine, device, or payer after an error.

Personal authorization shows a web approval link and an SVG QR code. The QR code encodes `pending.qrUrl`; this field is a deep link, not an image URL. Only HTTP(S) approval links and HTTP(S)/Paws QR payloads are accepted. Link targets open in a separate tab without opener access.

Disconnect pauses the local connection. Forget clears local connection material. Neither revokes the remote grant. Remote revocation belongs to a trusted owner interface. Supply `ownerManagementUrl` to link that interface. The panel has no revoke button and makes no revocation claim.

The optional remember checkbox affects the next connect call. The SDK chooses the storage mode. The panel shows the current mode in details and shows fallback warnings. It does not claim that inaccessible persistent material has been deleted.

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

Open `http://127.0.0.1:4186/?case=initial`. The fixture uses fake transport data through the real SDK controller. It does not contact a provider. Its controls simulate approval and a catalog change. Use `?case=pending`, `?case=ready`, `?case=limited`, or one of the recovery code names shown in the scenario menu. Add `&theme=dark` for a dark system theme. Storage warnings are simulated status data; they do not test real browser storage denial.

Fixture files are excluded from package exports and packed runtime files. Browser acceptance uses Ego. Real mobile approval and provider availability require separate integration acceptance.
