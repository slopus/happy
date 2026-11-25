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

What the computer last refused, or a pairing to redo, is the
list's first row (`SidebarList.notice`), never a card over it: it slides
down from above with the rows it pushes and rises back into the bar as it
goes, and read further down, the rows on screen stay where they are.

The list's room under the bar and above the toolbar's search field is read
only while home stands on top of the stack (`HomeListRoom`). Coming or going,
UIKit lays home out with its toolbar on its way, and no layout follows the
toolbar's return; read then, the list used to end under the search field
after any way back.

A hold on a conversation's row shows its preview. There is no menu.

Bots and tasks move as desktop moves them (`SidebarReorder`): a held row
that then moves lifts out of the list (its preview, if open, goes) and is
carried among its own kind only, a bot among the bots and a task among the
person's tasks, with its subtasks folded away until it is set down
(`SidebarCarryLayout`; held near the list's top or bottom, the list
scrolls). Set down, it is one `reorder` intent in the account's outbox,
told to the computer by desktop's routes (`POST /v0/bots/:id/reorder` with
`If-Match`, `POST /v0/tasks/:id/reorder`), as the row it now follows, nil
for first. Every move is kept as its own and they replay in the order made
(`IntentOverlay.moves`), so the row stands where it was put until the
computer's own order arrives, and goes back if the computer refuses.

A bot or task the person may archive (`Row.canArchive`) swipes toward its
leading edge (`SidebarSwipeLayout`): the row slides inside its card over
a red Archive, both clipped to the card. Let go past half the action, the
row stands open on it, and a tap on it archives; past 55% of the card the
action fills the row and letting go archives at once. As desktop's row
menu, archiving doesn't ask: the row goes through the outbox's `archive`
intent and comes back if the computer refuses. VoiceOver offers Archive as
the row's custom action.

## Live updates

The engine's one event stream (`/v0/events`): every `project.`,
`workspace.`, `bot.`, `task.`, `agent.`, `surface.` and `user_settings.`
event schedules a coalesced re-read of `/v0/bootstrap/desktop`. Status
lines, activity, renames, new or archived work, and other devices'
reorders all arrive this way.

## Tests

- `ClassicSidebarTests` (HappyCoreTests): the rows and their order, no
  titles and no folds.
- `SidebarReorderTests` (HappyCoreTests): what moves and with what, the
  move as the route's `afterId`, waiting moves replayed in order, and the
  routes. `SidebarSwipeLayoutTests` and `SidebarCarryLayoutTests`
  (HappyLayoutTests): the swipe's and the carry's frames.
  `SyncEngineTests` checks that the old Stem Cells setting leaves home
  classic and never reads the sidebar document.
- `ClassicSidebarUITests` (HappyDirectUITests), against a throwaway daemon
  with a driver: the list without titles, and a relaunch.
- `HostedHomeNoticeRowTests` (HappyUIKitHostedTests): the notice comes and
  goes through frames between, never over a row, and keeps the reader's
  place further down.
- `HostedHomeInsetsTests` (HappyUIKitHostedTests): a long home, a computer's
  and a Happy account's, at its top and at its end, back by Back, a finished
  swipe and a let-go swipe: the list's room never changes coming back.
  `HomeListRoom`'s frames are in `AccountSwitcherLayoutTests`.
