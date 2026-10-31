# The agent page

An agent's page (a task's, a bot's, a subtask's or a subagent's), opened
from its chat's title or its ⋮ menu's "Chat details". Code:
`ui/conversation/AgentPage.kt` (screen), `AgentPageEntry.kt` (data),
`conversation/AgentPage.kt` (model), `agent/AgentFamily.kt` (tree).

## The reference

iOS has the page, so it is the spec: `SessionDetailViewController`
(`happy-ios/Sources/HappyUI/Agents`), laid out by `SessionDetailLayout`
(`HappyLayout/Agents`), fed by `SessionDetail`/`SessionDetailFeed` and
`Shared`/`SharedFeed` (`HappyCore/Agents`). iOS pushes it from the chat
header's title capsule. Desktop has no page of this kind; its Activity
panel (`HappyAgentActivityPanel`) is where iOS took the Activity section
from. happy-app's session info screen is the legacy relay's and doesn't
apply. The page replaces the old "Chat details" list
(`ConversationDetailsScreen`), which only had title, status, mode, counts
and IDs.

Order and behaviour, as iOS's:

1. Mark 88 (iOS rounds a picture or placeholder at 0.22 of its side: 19),
   12 under the list's top; name 28/34 medium, 14 under it; kind line
   17/22 ("Task · Working", "Subtask", "Bot · Waiting for answer"), 2
   under that.
2. FAMILY: where it sits in home's tree, drawn with home's rows (mark,
   title with the sheen while running): nested, its parent, itself among
   its two nearest siblings each side (the window kept five wide at the
   ends) and its own children (eight at most); top-level, itself over its
   children. Alone: no card. Its own row is highlighted and goes back.
3. Tiles, two to a row, an odd last one the row's width: Model (the
   catalog's name, else the ID), Effort, Started (today/yesterday at a
   time, a weekday this week, a date this year, a date with its year).
4. MEDIA: Telegram's shared media in our card, three square cells to a
   row, 2 apart: pictures, recordings (first frame under a play button)
   and files (glyph and name). Four rows, then "Show more" adds four.
5. LINKS: links written by the person or the agent, Markdown text or
   host over the address. Five, then ten more per "Show more".
6. ACTIVITY: children at work and terminals running in one card; settled
   children folded under "Completed  N ›". Every child opens its chat.

Where Android differs on purpose:

- **Top bar.** iOS draws nothing over the page but the back button's
  glass. AGENTS.md rule 5 wants the standard bar on every screen, so it is
  `StackHeader` on glass, and its title fades in as the large name scrolls
  under it (Telegram's profile does the same).
- **Tokens tile.** iOS computes the subtree's tokens but shows no tile for
  them. Here it is a fourth tile when the daemon reports usage, so the
  tiles are a 2×2 grid; with none recorded the third tile takes the row,
  as iOS's odd tile does.
- **DETAILS card** (Steve's ask, not on iOS): provider, permission mode,
  context (`201K of 272K`), project, workspace (a project's worktree
  only), the agent that started it (opens its chat), and the agent ID
  (copied on tap). Each row shows only when the value is known.
- **Permission mode** is a read-only row. iOS moved the picker onto its
  page; here it stays in the chat's ⋮ menu, which still works, so the
  page doesn't edit the chat it sits over.
- **Rename.** iOS renames a task or bot from the name's pencil. Android
  has no rename path for tasks or bots yet, so there is no pencil.
- **Shimmer placeholders.** iOS shows nothing until the bootstrap
  answers. Here the unknown tile values and, while the first history page
  is read with nothing in hand, a row of Media squares shimmer
  (`Modifier.shimmer`, still with animations off).
- **Viewer.** Pictures and recordings open in the transcript's
  `PictureViewer`, paging through every picture and recording shared,
  newest first. iOS opens recordings in the system player; here they page
  in the viewer like the transcript's. The viewer fades in as it does from
  the transcript. A shared-element zoom from the cell isn't feasible: the
  viewer is a `Dialog` (its own window), and Compose's shared transitions
  only run inside one `SharedTransitionLayout`.
- **Files** open in the phone's app for them (`MediaOpener`), as the
  transcript's do; iOS uses Quick Look.

## Data, and where each value comes from

Everything is real; nothing is made up or estimated.

| Shown | Source |
|---|---|
| Name, mark, kind | Home's row (`AgentFeed`): bot/task name, picture or placeholder seed, kind. Else the agent's `title`, `subtask`, `parentAgentId`. |
| Working / waiting | The agent's `status` and `pendingQuestionId` (bootstrap, else the held chat's). |
| Family | `AgentFeed` rows' `parentId` (the daemon's `subtasks` tree, two levels). |
| Model, effort, permission mode | Bootstrap `mode`, else the held chat's. Names from `GET /v0/config` (`ModeCatalog`). |
| Started | `agent.createdAt`. |
| Tokens | Bootstrap `usage`: input + output summed over every provider and model, cache counters left out, as desktop counts a child's `totalTokens`. |
| Context | Bootstrap `context.contextTokens` / `contextWindow`. |
| Activity | Bootstrap `subagents` (with `totalTokens`, `archivedAt`, `subtask`) and `processes` (only `running` ones). |
| Project, workspace | The connection catalog's `workspaces` (`projectId`, `name`) and `projects`. |
| Parent | `parentAgentId`, named by home or the catalog. |
| Media, links | The held chat's rows (`ConversationState.rows`), then history: `GET /v0/agents/:id/messages?limit=10&omitToolData=true` a page at a time, at most six pages per ask, as far back as the sections need. |

All of it is in API.md ("The agent object", `GET /v0/agents/:id/bootstrap`,
`/usage`, `/activity`, "Background processes"); nothing new was added to
the wire, the daemon or the server.

- **Bootstrap** is read when the page opens and again as the agent's
  events come (`AgentEvent`s for this agent and every reconnect's hello):
  400 ms after the first, then at most every two seconds while they keep
  coming, as iOS's `SessionDetailFeed` does. A failed read keeps what was
  read; the page says why only while it knows nothing else.
- **The held chat.** When the page is opened over its chat, the chat's
  `ConversationHolder` is still on the back stack; the page reads its
  state (rows, agent, mode, catalog) from there (`heldConversation`),
  which is iOS's warm chat. Nothing is created if it's gone (process
  death, another stack); history alone then fills the page.
- **Shared** media and links come from the transcript's own rows
  (`ConversationRowBuilder`), so a page of history and the open chat give
  the same keys: pictures share their image-cache entries with the
  transcript, and the two merge without duplicates. Another agent's
  messages share nothing, as on iOS.

### What the wire doesn't have

- **Artifacts and Surfaces an agent produced.** The transcript has
  artifact rows, but iOS's `Shared` leaves them out and there is no
  per-agent artifact list on the wire (`GET /v0/artifacts` isn't filtered
  by agent), so the page has no Artifacts section.
- **Recent turns and tool runs** as a list. The bootstrap has no run
  summary; reading every run's tool calls would mean paging all of
  history. Activity is iOS's and desktop's: children and terminals.
- **Per-model usage** is on the wire, but the page shows one total, as
  iOS does.
- **Timing** (how long a run took) isn't reported; only `createdAt`,
  `updatedAt` and process `startedAt`.

## Layout and motion

- Cards on the content column's 16 inset (`ContentTokens.inset`), rounded
  26, 24 apart, on the grouped ground with surface cards, like Settings.
  `contentMaxWidth` holds the column, so the Fold's 750 inner screen gets
  the 640 measure centred (keyline 55) and a tablet the 800 column;
  `FoldableLayoutTest.agentPage` checks it at 411, 750, 832 and 1280.
- The list claims the glass bar's room (`barInsetTop`), so it starts
  under the bar's feather and scrolls on under the glass (bc1d94d94).
- Push and pop are the NavHost's one motion (`ui/NavMotion.kt`); the page
  has no transition of its own.
- Light and dark from `HappyTheme`; screenshots of both in
  `AgentPageTest` and `GlassScreenShots`.
