# Classic sidebar (Stem Cells off)

On a phone paired Direct to a Happy Agent, home is one of two sidebars, and
the person's Stem Cells setting picks it, exactly as on desktop
(`AppHappyAgentView.tsx`: `happyAgentStemCellsChosen`, then
`sidebar={spacesSidebar ?? sidebar}`):

| `happy-desktop.experiments.stemCells` | Home |
| --- | --- |
| `true` | the dynamic sidebar: the daemon's sidebar document (`/v0/spaces/sidebar`), `Store`, unchanged |
| anything else (missing, `false`, cleared) | the classic sidebar described here |

A daemon too old for the sidebar document also gets the classic list.

## The one choice

The setting is an ordinary per-person user setting. `SyncEngine` keeps the
person's settings in `direct.sqlite` and follows them live
(`/v0/bootstrap/desktop`'s `userSettings`, then `user_settings.updated`
events). `HomeSnapshot.usesSpaces` is that value, and nothing else decides:

- **While loading.** The engine reads its kept settings from disk before
  the network answers, so a relaunch paints the last answer this device
  heard. This is desktop's `hint`. The bootstrap, kept as the `desktop`
  checkpoint, paints the classic rows from the same disk read.
- **Live flips.** A flip on the computer arrives as `user_settings.updated`.
  The engine re-derives, and `HomeViewController` swaps lists in place:
  `applyConnection` → `apply`/`applyClassic`. No new screen is pushed, so
  whatever is pushed over home stays. Turning it on also reads the sidebar
  document right then (`resyncSidebar(loadSidebar: true)`). Turning it off
  stops drawing the document; the classic rows are already current.
- **No switch on the phone.** Settings has no Stem Cells switch. The
  setting changes on desktop or through the API, and home follows it.

## What it shows

`SidebarRows.make` mirrors desktop's `happyAgentTopSection` +
`happyAgentSections`, from the ordinary APIs only. It never reads the
sidebar document, whose edits don't sync to these orders and are not
affected by them (API.md, Spaces):

1. **Artifacts**, pinned, then the person's **joined Surfaces** in their
   member `orderKey` order. No heading.
2. **Bots**, in catalog order. Hidden bots (`happy-desktop.bot.<id>`) are
   left out, and muted ones draw quiet. Each bot's active subtasks nest
   under it.
3. **Tasks**: the person's own memberships, in their order, with subtasks
   nested.
4. **Projects** (unless Hide projects is on), in `orderKey` order. Each
   project lists its sessions, then its worktrees (`orderKey`) with their
   sessions. A worktree a subtask works in is listed once, under that
   subtask.

Rows use the phone's own components (`SidebarView`, `RowView`). With agent
stories on, every bot's and task's row is a story row (`StoryRowViews`):
the ring with its stories, the time, the agent's status line on two lines,
and the corner signal. `ClassicDrag.withStories` keeps the tree, unlike the
spaces sidebar's top-level-only story list, because projects and their
sessions live here. Nested rows, folders and headings stay plain rows.
Folds are this phone's own (`SyncEngine.fold`), as before.

## Live updates

The engine's one event stream (`/v0/events`): every `project.`,
`workspace.`, `bot.`, `task.`, `agent.`, `surface.` and `user_settings.`
event schedules a coalesced re-read of `/v0/bootstrap/desktop`. Status
lines, activity, renames, new or archived work, and other devices'
reorders all arrive this way. Rings come from the stories store, as on the
dynamic sidebar.

## Reordering

Desktop's classic `Sidebar` reorders within a section, and so does this
list:

| Row | Peers | Route (as desktop's `onItemReorder`) |
| --- | --- | --- |
| Joined Surface | the other joined Surfaces, under Artifacts | `POST /v0/surfaces/:id/reorder` |
| Bot (Happy too) | the other bots | `POST /v0/bots/:id/reorder` (`If-Match`) |
| Task | the person's other tasks | `POST /v0/tasks/:id/reorder` |
| Subtask | its siblings under the same parent | `POST /v0/agents/:id/subtask-reorder` |
| Project | the other projects | `POST /v0/projects/:id/reorder` (`If-Match`) |
| Worktree | the project's other worktrees | `POST /v0/workspaces/:id/reorder` (`If-Match`) |

Never: a section heading, Artifacts, a project's or worktree's session, or
any row into another section. `ClassicDrag.drag` builds a `Drag` whose
peers are only the held row's family. The rows before and after it are
fixed, so a slot in another section simply does not exist: the carry stops
at the family's edge and lands there. The carry, the lift preview, the gap
and the drop are the dynamic sidebar's own (`SidebarView`). Lifting is a
hold-and-move or the hold menu's Reorder.

A drop asks the engine (`SyncEngine.reorder`). The family is drawn in its
new order at once (`ClassicDrag.held`), the route is called with
`{afterId, mutationId}`, and the bootstrap is read again. A refusal puts
the row back and says why over the list.

## Tests

- `ClassicSidebarTests` (HappyCoreTests): the rows and their order, story
  rows that keep the tree, every reorder family, refused sections and
  cross-section slots, the held order, the routes, a refusal, and the
  choice following the setting live, kept across a relaunch.
- `ClassicSidebarUITests` (HappyDirectUITests), against a throwaway daemon
  with a driver: the classic list, a reorder within Bots, a refused drag
  into Tasks, Stem Cells on and off live, and a relaunch.
