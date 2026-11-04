# Native Calendar interaction

Calendar follows desktop5e4edea3; iOS has no Calendar editor. Desktop
HappyAgentCalendarWeekView.tsx:29–42,152–180 supplies48dp hours,15minute
snapping and a15minute minimum resize. Its surfaceCalendarStore.ts:326–381
retimes the whole series by local days/start time and shifts named weekdays
and the inclusive ending. No recurrence expansion runs on the phone.

Touch uses the system long-press before moving, so ordinary vertical and
horizontal calendar scrolling stays available. The bottom8dp of a timed
event is its resize grip; all-day bars move by whole days. A12×2dp grip
marks the edge. Those grip dimensions are this native port's choice, not
Telegram or desktop constants. TalkBack exposes equivalent previous/next
day, earlier/later and shorten/extend actions.

Telegram Android3de37c8 ItemTouchHelper.java:813–897 keeps the selected item
under the finger and commits after release; ChatMessageCell.java:5572 uses
keyboard-tap haptics when a todo changes. The calendar independently uses
Compose pointer capture, a lifted event above its neighbors, native
long-press/drop haptics, and only the final snapped timing is sent. Cancellation
sends nothing. There is no animation after the finger releases, so reduced
motion uses the same direct placement. The phone can scroll across days
before holding an event; automatic edge scrolling is not implemented.