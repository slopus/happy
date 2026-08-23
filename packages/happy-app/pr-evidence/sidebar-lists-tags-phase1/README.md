# Sidebar Lists and Tags phase 1 visual evidence

Visible UI cases: 2. The screenshots were captured by the isolated Web E2E
harness in Chromium, English, light theme, and DPR 1.

- Case 1, desktop 1440x900: Projects remains the default. Lists supports
  Workspace and Agent types, edit/delete actions, one-to-many Tags, and reload
  persistence while the conversation and Capability Hub remain unchanged.
  Additional after frames show the Workspace row, the selected machine and
  directory after reload, the Agent List opening a true Ask-mode empty input,
  and the cross-list Tag filter.
- Case 2, mobile 390x844: the drawer keeps Projects as the default and adds a
  compact Lists tab without navigating away from the current conversation.
  Created Lists expose separate edit and delete actions, deletion requires a
  destructive confirmation, and the deleted List stays absent after reload.
  The visible tab surface is at most 32px high and every affected action keeps
  at least a 44px touch target.

`case-3-after-100-sessions-responsive.png` is supplemental E2E evidence, not a
third visual Before/After case. It shows that the 100-session group renders a
windowed subset and remains responsive when collapsed and expanded.

Automated evidence:

- `SIDEBAR-LISTS-TAGS`: create, rename, organize, Tag, delete, and reload.
- `SIDEBAR-LISTS-TAGS-MOBILE`: compact tabs, touch targets, create/delete,
  destructive confirmation, reload persistence, stable route, and no
  horizontal overflow.
- `SIDEBAR-LISTS-TAGS-PERF`: 100 sessions, virtualized mounting, and an expand
  response under five seconds.

The stable desktop acceptance video is generated from eleven passing E2E states
at 1440x900, H.264, yuv420p, 25fps. It passed `ffprobe`, full decode, and full
duration contact-sheet review.

The mobile List-delete acceptance video uses four passing E2E states at
720x1558, H.264, yuv420p, 25fps. It passed `ffprobe`, full decode, and full
duration contact-sheet review.
