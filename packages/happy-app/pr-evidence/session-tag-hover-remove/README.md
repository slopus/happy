# PC session Tag hover removal

Case: `SESSION-TAG-HOVER-REMOVE`

- Viewport: 1440 × 900, Gingham dark theme.
- `06-rest-tag.png`: the Tag keeps its compact resting appearance and the remove action is hidden.
- `07-hover-remove-tag.png`: hovering `#product` reveals a close button inside the chip.
- `08-tag-removed.png`: clicking close unassigns `#product` from the current session, keeps `#research`, and leaves the global `product` Tag visible with a count of zero.

Automated coverage also verifies that keyboard focus reveals the same remove action and that the session's List assignment is preserved.
