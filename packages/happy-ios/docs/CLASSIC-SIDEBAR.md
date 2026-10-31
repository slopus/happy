# Home's sidebar

On a phone paired to a Happy Agent, home is desktop's classic sidebar,
built from the ordinary APIs (`SidebarRows`). The Stem Cells experiment
(`happy-desktop.experiments.stemCells`) and its dynamic sidebar, drawn from
the daemon's sidebar document (`/v0/spaces/sidebar`), are gone from home:
whatever that setting holds, home is this list, and the phone never reads
the sidebar document for it.

The engine reads its kept bootstrap (the `desktop` checkpoint in
`direct.sqlite`) before the network answers, so a relaunch paints the
last rows this device heard.

## What it shows

`SidebarRows.make` mirrors desktop's `happyAgentTopSection` +
`happyAgentSections`, from the ordinary APIs only. It never reads the
sidebar document, whose edits don't sync to these orders and are not
affected by them (API.md, Spaces). Sections have no titles: each is its
own card, parted from the one before by a separator row. Nothing folds:
every nested row is shown, and no row has a chevron.

1. **Artifacts**, pinned, then the person's **joined Surfaces** in their
   member `orderKey` order.
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
and the corner signal. `SidebarRows.withStories` keeps the tree, unlike the
spaces sidebar's top-level-only story list, because projects and their
sessions live here. Nested rows and folders stay plain rows.

A hold on a conversation's row shows its preview. There is no menu and
nothing moves: the phone doesn't reorder this list.

## Live updates

The engine's one event stream (`/v0/events`): every `project.`,
`workspace.`, `bot.`, `task.`, `agent.`, `surface.` and `user_settings.`
event schedules a coalesced re-read of `/v0/bootstrap/desktop`. Status
lines, activity, renames, new or archived work, and other devices'
reorders all arrive this way. Rings come from the stories store.

## Tests

- `ClassicSidebarTests` (HappyCoreTests): the rows and their order, no
  titles and no folds, and story rows that keep the tree.
  `SyncEngineTests` checks that the old Stem Cells setting leaves home
  classic and never reads the sidebar document.
- `ClassicSidebarUITests` (HappyDirectUITests), against a throwaway daemon
  with a driver: the list without titles, and a relaunch.
