# Bots / native Rakazo acceptance

Validated on 2026-11-14 against native Rakazo revision
`c71c0c6bb6f00e511ece8fa6a919d282c129bbd3`, with the real local GPT gateway.
Paws changes retain main's composer context picker (`e11f5744`) and session-entry
position fix (`f14c5ef3`).

## Environment

The full Paws Web App and server use isolated PGlite and two synthetic accounts.
Bots uses actual Rakazo Web/API/worker/PostgreSQL containers and the actual local
GPT provider. Neither the conversations nor model replies are mocked. The fixture
starts no Paws daemon and changes no production listener or account.

`queryAuthOnly` is required for this multi-account fixture: authenticate once
through its private query URL, then retain the selected vault identity. The
environment's usual default development credentials otherwise replace that
identity on every reload. Early account labels affected by that fixture mistake
were not used as final isolation evidence.

## Web results

| Case | Observed result | Result |
| --- | --- | --- |
| B1 | Bots immediately below Home; selected state; 60px rail and native Bot workspace | Pass |
| B2 | Native thread sends to local GPT and receives the requested unique reply; run stops | Pass |
| B3 | Second Bot created with native UI; native `@` menu lists chief and second Bot | Pass |
| B4 | Home removes the iframe and restores the 420px session sidebar | Pass |
| B5 | Returning to Bots recovers the same native chief and real reply | Pass |
| B6 | Full refresh retains chief, Bots and conversation history | Pass |
| B7 | 1440×900 and 1024×768 desktop, Gingham dark, no page horizontal overflow | Pass |
| B8 | Distinct Paws subjects map to distinct native users/spaces; account one has its own reply and no second account Bot; account two has its two Bots and no account-one reply | Pass |
| B9 | Unavailable service shows generic error; explicit reopen/retry succeeds after native admission recovers | Pass |

The seven-case ordinary run and final seven-case visual replay passed. A database
read before and after repeated navigation/reload showed the native credential
request count unchanged (4 → 4); the gateway reused valid per-account sessions.
Native credential rate limiting remained enabled throughout.

The visual replay consists of seven verified states, not a continuous recording.
It was encoded as a 1440×900 H.264/yuv420p, 30fps MP4; all states were visually
checked and the complete video decoded successfully. Screenshots and the video
are private acceptance artifacts delivered through Happy, not public PR assets.
Mobile playback has not been confirmed.

## Automated and independent checks

- Initial merged App regression selection: 180 tests; full App typecheck and Web export.
- After integrating `f14c5ef3`: 343 session-entry/Bots/retirement regressions and
  full App typecheck passed. This includes the message-visibility case that failed
  in merged CI; the test now awaits the scheduled verification task before
  asserting its unchanged latest-message contract, rather than applying a default
  1s budget to the whole async operation. The original complete local App suite
  passed 4674 tests; the adjusted 194-test visibility suite and full typecheck
  passed. Current-head CI is tracked separately in the PR.
- Gateway/loader/stack: 24 tests; server Bots route/gateway: 7 tests.
- CLI retirement: 51 tests, CLI build/typecheck, built-command retirement and
  byte-preservation checks. App retirement also has a separate 262-test report;
  these counts overlap other regression selections and must not be added together.
- Independent source review covered App boundaries, per-subject identity/cache,
  single-use tickets, exact origin/frame checks, SSE cancellation/revocation,
  fixed upstream origin construction and native sealed-screen routing.
- Review findings were fixed and independently rechecked. Browser acceptance is
  separate from those source/unit-test conclusions.
- Independent screenshot review passed the Paws integration layout. One upstream
  P2 remains: Rakazo's floating Bot-name pill overlaps some older text/time labels
  as the transcript scrolls underneath it. Latest replies and the composer remain
  usable. The native interface has been retained; this is not an all-UI-perfect claim.

## Not accepted or activated

- Production Paws Web/server/daemon activation: not deployed or merged by this validation.
- Android/iOS WebView: no device verification; Service Worker support is required.
- Computers: disabled with `SANDBOX_PROVIDER=none`; no provider, host shell or
  native `agent-browser` exception enabled.
- Provider OAuth/integration authorization, offline PWA and native credential
  management: not accepted through this embedded gateway.

See [Bots setup and boundaries](../bots.md) and the integration gateway README.
