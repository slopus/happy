# Upstream provenance

`vendor/agents-party` contains an unmodified backend subset of
[1gr14/agents-party](https://github.com/1gr14/agents-party) at commit
`af00afbd49b3235c2084cff9849ef12353073484` (MIT):

- `LICENSE`
- `src/core/{colors,crypto,dirs,errors,names,types}.ts`
- `src/registry/{registry,sqlite}.ts`
- `src/server/{api,wake}.ts`
- `src/store/{pool,sqlite-driver,store}.ts`

The files retain their original paths beneath `vendor/agents-party` and are
byte-for-byte copies. Paws-specific authentication, orchestration, assets, and
HTTP hosting live outside the vendor directory.

`src/server/protocol.ts` and the remote turn execution design are adapted from
the earlier private Paws consultation POC at
`packages/paws-consultation/src/{protocol,remoteAgent}.ts` in commit
`5310220857a88b662936af1f5a6f028d88b935ee`. No LangGraph consultation code is
copied.

## Task 2 browser fork

Mechanically imported from that same pinned MIT commit using apply_patch:

- `src/ui/party/{chat,composer,message,sidebar,diff-modal}.tsx`, `view-mode.ts`
- `src/ui/components/{badge,button,infinite-scroll,menu,textarea,input}.tsx`
- `src/ui/utils.ts`, `src/core/{diff,mentions}.ts`

The original backend subset above remains byte-for-byte unchanged. UI changes:

- Chat and Sidebar import types directly from `core/types.ts`, avoiding the root server barrel.
- Chat adds optional participant-detail, rich-message, composer-content and extension hooks; participant names open details when configured, separate recipient chips retain addressing. The original layout, filters, DiffModal fallback, virtual lists, and Sidebar remain.
- Composer supports attachment-only submissions, accessible Chinese labels, visible caught send errors/draft retention, and file-input interaction inside its toolbar. It resets per Party via Chat's key.
- Chat, Composer, Sidebar, MessageText and view-mode copy are translated for this POC.
- InfiniteScroll configures `useFlushSync: false` for the pinned TanStack React Virtual 3.14.9/React 19 integration; the real virtualizer remains. This avoids React lifecycle flushSync warnings observed in rendered history-update tests.

`src/web/PartyApp.tsx` is adapted from the original **`web/src/party-app.tsx`**, not a replacement chat. It retains owner Party listing/paging, participant reads, decrypted messages, long-poll history loading, theme/header, and the original Chat composition. Changes wire Bearer-token bootstrap, the tested receive-only cursor reducer, stale-response guards, saved Party restoration, Paws connection/run controls, role details, rich attachments, and idempotent follow-ups. Original invite/delete/direct generic Party send controls are not exposed in this POC.

`src/web/lib/{crypto,theme}.ts` are unchanged copies of upstream `web/src/lib/{crypto,theme}.ts`; browser crypto uses WebCrypto, never the Node crypto module. `src/web/styles.css` copies upstream `web/src/styles/index.css` with only corrected Tailwind scan paths and semantic-token-based POC panel/form styles. The SPA HTML/entry and Paws panels are local integration code. No Point0, React Query, Unhead, Wouter, Expo, Unistyles or Tauri runtime was imported. No external font assets/requests were added.

Task 2 also closes the approved design's provenance gap through minimal compatible fields in local contracts/run storage and a decoder getter. Each turn records its Party task ID, returned Party public reply ID, SDK localId, exact session/rootTurnId and durable turn-end sourceMessageId; absent fields are not guessed. This does not add an orchestration framework or event database.
