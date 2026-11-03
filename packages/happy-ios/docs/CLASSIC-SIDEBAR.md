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

Every project wears a face, as desktop's sidebar does: its picture (the
person's or the one the daemon made, read at `/v0/projects/<id>/avatar`
with its thumbhash first), the house for the home project, and while it has
neither yet, the placeholder its id seeds (`SidebarRows.projectMark`).

On a team computer (the bootstrap's `profile.userId` is set) a task wears
the face of the member it belongs to, who made it (`task.ownerUserId`), in
place of its placeholder (`SidebarRows.authorMark`): the person's own from
the profile's photo, everyone else's from `GET /v0/users?ids=`, read at
`/v0/users/<id>/photo` with the thumbhash first. A member without a picture,
or not read yet, wears their own placeholder, seeded by their bare user ID
(`PersonSeed`), as the Profile page seeds it. A task nobody owns, bots,
Surfaces and projects are
unchanged, and so is a standalone computer. The engine reads the authors it
doesn't know after each bootstrap, again on reconnect and on a
`profile.updated` naming one, and keeps them in a `users` checkpoint beside
the bootstrap, so a relaunch draws them offline. A task's profile wears its
home row's mark.

The list is `SidebarList`, on UltraView: `SidebarLayout`'s grouped cards
cut into one slot per row (`SidebarLayout.slots`), laid out and drawn off
the main thread (`SidebarItemDrawing`), with the marks, fills and working
signals as live views over the bitmap (`SidebarItemView`); a working
bot's, task's or subtask's title keeps `RowView.shimmers`'s sweep as a
`ShimmerBand` over the drawn title. Rows that change above the screen keep
the reader's place (`SidebarScrollAnchor`, as `SidebarView` does). It draws what
the grouped `SidebarView` drew (`HostedSidebarListTests` compares them
pixel for pixel). Search's results over home are a `SidebarList` too
(`HomeSearchResultsView`, `startsEachChangeAtTop`: new results show at once
from the top; `HostedSearchResultsListTests`). `SidebarView` and `RowView`
stay for a session's tree and proposals, which are drawn whole, folding,
inside another screen's scroll. UltraList is not a scroll view, so
the bar's soft edge and the indicator follow `SidebarList.edge`, a scroll
view holding the list that moves with it.

What the computer last refused ("The computer did not answer.") is the
list's first row (`SidebarList.notice`), never a card over it: it slides
down from above with the rows it pushes and rises back into the bar as it
goes, and read further down, the rows on screen stay where they are.

The list's room under the bar and above the toolbar's search field is read
only while home stands on top of the stack (`HomeListRoom`). Coming or going,
UIKit lays home out with its toolbar on its way, and no layout follows the
toolbar's return; read then, the list used to end under the search field
after any way back.

A hold on a conversation's row shows its preview. There is no menu and
nothing moves: the phone doesn't reorder this list.

## Live updates

The engine's one event stream (`/v0/events`). An `agent.updated` that
carries only the agent's own state (status, status line, activity,
title, wait, retry; `AgentPatch.inPlace`) and follows the version the
phone holds is merged into the held catalog, as desktop's
`connectHappyAgent` does. The daemon sends one with every streamed token,
so this is what keeps a working agent from re-reading the catalog several
times a second. Home publishes only when a row it shows changed, and the
kept catalog is written at most every 2 s, only then.

Anything else (a version gap, an agent not held, `unread`, archival,
order, subtasks) and every other `project.`, `workspace.`, `bot.`,
`task.`, `agent.`, `surface.` and `user_settings.` event schedules a
coalesced re-read of `/v0/bootstrap/desktop`. Renames of projects, new
or archived work, and other devices' reorders arrive this way. An agent's
draft, context, profiles and slash commands are its conversation's and
never re-read Home.

## Tests

- `ClassicSidebarTests` (HappyCoreTests): the rows and their order, no
  titles and no folds.
  `SyncEngineTests` checks that the old Stem Cells setting leaves home
  classic and never reads the sidebar document.
  `AgentPatchTests` checks that 200 streamed `agent.updated` read the
  catalog 0 times and publish Home exactly twice (working, then idle),
  and that a version gap reads it once.
- `ClassicSidebarUITests` (HappyDirectUITests), against a throwaway daemon
  with a driver: the list without titles, and a relaunch.
- `HostedHomeNoticeRowTests` (HappyUIKitHostedTests): the notice comes and
  goes through frames between, never over a row, and keeps the reader's
  place further down.
- `HostedHomeInsetsTests` (HappyUIKitHostedTests): a long home, a computer's
  and a Happy account's, at its top and at its end, back by Back, a finished
  swipe and a let-go swipe: the list's room never changes coming back.
  `HomeListRoom`'s frames are in `AccountSwitcherLayoutTests`.
