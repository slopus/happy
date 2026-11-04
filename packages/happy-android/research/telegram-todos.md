# Todo interactions

Reference: Telegram Android 3de37c8 (v13.1.1). Numbers and presentation come
from Happy iOS 263d7a7c5 unless specified otherwise. This is an independent
Compose implementation; no Telegram source was copied.

`ChatMessageCell.java:5567-5600` updates a chosen todo, runs keyboard-tap
haptics and animates only its checkbox before invalidating the cell. Android
todos similarly apply the pending change immediately, keep the keyed row in
place, and draw the check separately from row measurement. Happy's check uses
mass 1, stiffness 100, damping 12, initial velocity 4; the check stroke starts
after 80 ms and draws over 200 ms. A completed row holds for 650 ms. Reduced
motion bypasses the pop and hold.

`recyclerview/ChatListItemAnimator.java:440-475,765-796,984-994` preserves row
geometry and uses translation for moves, resetting transforms on completion.
`androidx/recyclerview/widget/ItemTouchHelper.java:813-897,1818` finds visible
swap targets while keeping a selected holder under the finger. Android todos
keep a local keyed order while dragging and commit only the final slot. The
pointer transform subtracts the row's current lazy-list offset, so reordering
and edge scrolling do not pull the lifted row away from the finger. Happy's
350 ms hold, 200 ms ease-in-out lift to 1.03, haptics and 250 ms ease-out setdown take precedence over
Telegram timings.

`Components/UndoView.java:409-432` animates an undo overlay by translation or
scale/alpha without changing list geometry. Happy uses its own 50 dp capsule,
480 dp maximum width, 16 dp side inset, 12 dp bottom inset, five-second window,
300 ms spring entrance (damping ratio .85, +16 dp) and 200 ms fade exit. Undo
keeps both the deleted item's previous active-list neighbor and its completed
status, including when the request is still waiting in the shared intent
outbox.

Compose animation callbacks run on the UI dispatcher. The transform and check
draw blocks avoid layout on each animation tick; this alone is not proof that
an animation remains independent of a blocked UI thread. Software rendering
on the shared emulator VM is unsuitable for frame-time claims.