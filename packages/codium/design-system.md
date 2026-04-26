# Codex Design System Notes

These notes describe the inspected Codex desktop app, not Codium's implementation. The source snapshot was taken from the running macOS Codex app via the Chrome DevTools Protocol on `app://-/index.html?hostId=local`.

Observed app version:

- App title: `Codex`
- User agent: `Codex/26.422.30944 Chrome/146.0.7680.179 Electron/41.2.0`
- Theme class: `electron-dark`
- Viewport sampled: `1344 x 877`

## Visual Direction

Codex is a dense desktop tool UI. It uses a transparent macOS sidebar, a dark rounded main surface, compact 28-30px controls, low-contrast token borders, and almost no decorative gradients. The design language is practical and quiet:

- Surfaces are flat or slightly elevated.
- Borders are usually translucent white at very low opacity.
- Hover states use subtle translucent fills.
- Gradients are functional, mostly for resize affordances and fade masks.
- Text is small: 12px for sidebar/control labels, 13px for body and menus.

## Token Vocabulary

Codex uses Tailwind-like utility classes backed by semantic tokens. The important observed class families are:

| Family | Examples | Meaning |
| --- | --- | --- |
| Text | `text-token-foreground`, `text-token-description-foreground`, `text-token-muted-foreground`, `text-token-text-link-foreground` | Primary, secondary, muted, and link text |
| Background | `bg-token-bg-fog`, `bg-token-input-background/90`, `bg-token-side-bar-background`, `bg-token-dropdown-background` | Quiet control, composer, sidebar, dropdown surfaces |
| Border | `border-token-border`, `border-token-border/70`, `bg-token-border-default` | Default borders and dividers |
| Hover | `hover:bg-token-list-hover-background`, `enabled:hover:bg-token-list-hover-background` | Row/control hover fill |
| Radius | `rounded-lg`, `rounded-md`, `rounded-full`, `rounded-3xl`, `rounded-s-2xl` | Rows, icon buttons, pills, composer, main surface |
| Sizing | `h-toolbar`, `h-token-button-composer`, `h-token-button-composer-sm`, `size-token-button-composer` | Header and compact button heights |
| Spacing | `px-row-x`, `py-row-y`, `px-toolbar`, `px-panel` | System row/header/panel spacing |

Computed dark colors from the inspected UI:

| Use | Value |
| --- | --- |
| Body translucent window background | `color(srgb 0.156863 0.156863 0.156863 / 0.55)` |
| Main surface | `rgb(24, 24, 24)` |
| Primary foreground | `rgb(255, 255, 255)` |
| Tertiary/muted foreground | `rgba(255, 255, 255, 0.498)` |
| Link/accent text | `rgb(131, 195, 255)` |
| Button fog background | `rgba(255, 255, 255, 0.03)` |
| Standard border on split buttons | `rgba(255, 255, 255, 0.082)` |
| Main surface outline ring | `rgba(255, 255, 255, 0.157)` |
| Main surface shadow | `rgba(0, 0, 0, 0.08) 0px 2px 4px -1px` |

## Typography

Observed text sizes:

| Context | Size | Line height | Weight |
| --- | --- | --- | --- |
| Body/default browser base | `16px` | `24px` | `400` |
| App body text / editor | `13px` | `19.5px` | `400` |
| Sidebar rows | `12px` | `17.1429px` | `400` |
| Composer footer labels | `12px` | `18px` | `400` |
| Header split buttons | `13px` | `18px` | `400` |
| Home headline | class `heading-xl` | not measured in this pass | `400` via `font-normal` |

Use `truncate`, `min-w-0`, and `whitespace-nowrap` heavily. Codex prefers one-line labels with ellipsis over wrapping in navigation and controls.

## App Shell

### Window Background

The body is translucent:

```css
background-color: color(srgb 0.156863 0.156863 0.156863 / 0.55);
```

The sidebar sits on this transparent window background rather than a solid panel.

### Sidebar

Measured sidebar:

- Width: `318.93px` (`319px` target).
- Height: full viewport.
- Top padding: `46px`, matching toolbar height.
- Background: transparent.
- Border: no visible solid sidebar border in the sampled aside itself.
- Nav content begins at `y = 46px`.

Sidebar nav rows:

- Row width: `302.93px`.
- Row height: `29.5px`.
- Row padding: `5px 8px`.
- Row gap: `8px`.
- Row radius: `12.5px`.
- Text size: `12px`.
- Line height: `17.1429px`.
- Hover class: `hover:bg-token-list-hover-background`.
- Focus: `focus-visible:outline-token-border`, `outline-2`, `outline-offset-2`.

Section headers such as `Projects` are quieter:

- Height: `23.5px`.
- Padding: `2px 4px 2px 0`.
- Radius: `10px`.
- Text size: `13px`.
- Color: `rgba(255, 255, 255, 0.498)`.

### Main Surface

The main work surface is the strongest framed shape:

- Left offset: starts after `319px` sidebar.
- Background: `rgb(24, 24, 24)`.
- Radius: `12.5px 0 0 12.5px` (`rounded-s-2xl`).
- Shadow stack:

```css
box-shadow:
  rgba(0, 0, 0, 0) 0px 0px 0px 0px,
  rgba(0, 0, 0, 0) 0px 0px 0px 0px,
  rgba(0, 0, 0, 0) 0px 0px 0px 0px,
  rgba(255, 255, 255, 0.157) 0px 0px 0px 0.5px,
  rgba(0, 0, 0, 0.08) 0px 2px 4px -1px;
```

The important detail is the `0.5px` translucent white ring. This is the primary border for the main surface.

## Borders

Borders are tokenized and low contrast. They are used more as surface separators than visible outlines.

### Default Border

Split buttons and framed header controls use:

```css
border-color: rgba(255, 255, 255, 0.082);
```

Observed on header split buttons:

- `border-token-border`
- `border`
- `border-r-0` or `border-l-0` for attached split-button halves.

### Transparent Border Reservation

Many buttons use `border-transparent` while still carrying the `border` class. This reserves layout space so hover/open states do not shift the control.

Observed examples:

- Sidebar/top icon buttons.
- Composer icon buttons.
- Tertiary toolbar buttons.

### Divider Border

Codex uses `border-token-border/70` and `divide-token-border/70` for quieter separators in menus/lists. The intent is visible separation only at close range.

### Focus Border

Focus rings are outlines, not heavier borders:

- `focus-visible:outline`
- `focus-visible:outline-2`
- `focus-visible:outline-offset-2`
- `focus-visible:outline-token-border`

Composer send focus uses `focus-visible:outline-token-button-background`.

## Gradients And Fades

Codex uses very few gradients. They are utility/affordance gradients, not decorative backgrounds.

### Sidebar Resize Handle

The clearest actual gradient is the sidebar resize handle:

```text
sidebar-resize-handle-line
bg-gradient-to-b
from-transparent
via-token-foreground/25
to-transparent
```

Measured handle:

- Width: `1px`.
- Height: `923px` in the sampled viewport.
- Horizontal margin: `0 5.5px`.
- Initial opacity: `0`.
- Visible on group hover/active via `group-hover:opacity-100` and `group-active:opacity-100`.

This gradient is a vertical line that fades at both ends.

### Text Fade Masks

Long sidebar/folder rows use mask gradients when hover/focus actions appear:

```text
group-focus-within:[mask-image:linear-gradient(to_right,transparent_0,transparent_21px,black_26px)]
group-hover:[mask-image:linear-gradient(to_right,transparent_0,transparent_21px,black_26px)]
```

This is not a visible background gradient. It is a text/content mask that prevents overlap with row actions.

### Scroll Fade Mask

The sidebar contains `vertical-scroll-fade-mask`, indicating a vertical fade at scroll boundaries. Treat this as a functional overflow affordance.

### Not Used As Decoration

No large hero gradients, orb gradients, or decorative color washes were observed. The main app depends on surface color, blur, borders, and shadows instead.

## Toolbar And Header Controls

Header controls are compact, often split-button pairs.

Observed split button values:

- Height: `28px`.
- Text size: `13px`.
- Line height: `18px`.
- Background: `rgba(255, 255, 255, 0.03)` (`bg-token-bg-fog`).
- Border: `rgba(255, 255, 255, 0.082)`.
- Left half radius: `12.5px 0 0 12.5px`.
- Right half radius: `0 12.5px 12.5px 0`.
- Left half padding: `0 4px 0 8px`.
- Right half padding: `0 6px 0 2px`.
- Icon-only tertiary buttons: `36px x 28px`, padding `0 8px`, radius `12.5px`, transparent border/background.

Attached split buttons remove the shared border:

- Left half: `border-r-0`.
- Right half: `border-l-0`.

## Composer

The Codex composer is a centered, elevated input with a pill-like rounded shape.

Observed classes:

```text
rounded-3xl
bg-token-input-background/90
ring
ring-black/10
backdrop-blur-lg
electron:shadow-[0_4px_16px_0_rgba(0,0,0,0.05)]
electron:dark:bg-token-dropdown-background
```

Measured composer/editor area:

- Composer content width: `728px`.
- Editor visual width: `704px`.
- Editor height in empty state: `40px`.
- Editor max height: `25dvh`.
- ProseMirror min height: `2rem`.
- Text size: `13px`.
- Line height: `19.5px`.

Composer footer:

- Width: `728px`.
- Height: `28px`.
- Display: grid.
- Columns: `minmax(0, auto) auto minmax(0, 1fr)`.
- Gap: `5px`.
- Padding: `0 8px`.
- Margin bottom: `8px`.

Footer controls:

- Main button height: `28px`.
- Small button height: `28px` in measured state.
- Label font: `12px`.
- Label line height: `18px`.
- Pill radius: `9999px`.
- Text color for inactive controls: `rgba(255, 255, 255, 0.498)`.
- Link/accent label color: `rgb(131, 195, 255)`.
- Icon-only composer buttons: `28px x 28px`.
- Send button: `28px x 28px`, `9999px` radius, white background, `0.5` opacity when disabled.

## Buttons

General button pattern:

- Keep a `border` even when transparent.
- Use `cursor-interaction`.
- Use `user-select-none`.
- Use `whitespace-nowrap`.
- Disabled state: `disabled:cursor-not-allowed` and either `disabled:opacity-40` or `disabled:opacity-50`.
- Hover/open state: `enabled:hover:bg-token-list-hover-background` and `data-[state=open]:bg-token-list-hover-background`.

Control sizes:

| Control | Size |
| --- | --- |
| Sidebar row | `303px x 30px` sampled |
| Header split button | `28px` high |
| Header icon-only tertiary | `36px x 28px` |
| Sidebar section icon button | `24px x 24px` |
| Composer icon button | `28px x 28px` |
| Composer send button | `28px x 28px` |

## Radius Scale

Observed radii:

| Radius | Use |
| --- | --- |
| `10px` | Section toggle, compact icon button |
| `12.5px` | Sidebar rows, header split buttons, main surface side radius |
| `9999px` | Composer footer pills and circular send button |
| `rounded-3xl` | Composer shell |
| `rounded-b-2xl` | Lower rounded panel in prompt/options area |

Codex often uses `rounded-lg` utility classes, but computed radius in the sampled environment is `12.5px`.

## Spacing Scale

Observed spacing:

| Context | Value |
| --- | --- |
| Sidebar row padding | `5px 8px` |
| Sidebar row gap | `8px` |
| Section toggle padding | `2px 4px 2px 0` |
| Header split left padding | `0 4px 0 8px` |
| Header split right padding | `0 6px 0 2px` |
| Header icon padding | `0 8px` |
| Composer footer padding | `0 8px` |
| Composer footer gap | `5px` |
| Composer footer bottom margin | `8px` |
| Composer small pill padding | `0 6px` |
| Composer standard pill padding | `0 8px` |

## Shadows And Elevation

Codex uses minimal elevation:

- Main surface: `0.5px` white ring plus subtle shadow.
- Composer: `0 4px 16px rgba(0,0,0,0.05)` in Electron.
- Dropdown/composer background uses blur and opaque token surfaces rather than large shadows.

The main visual separation comes from border rings and surface contrast, not heavy drop shadows.

## Plugins Catalog

The Plugins screen keeps the same shell but uses content-centered catalog sections.

Observed structure:

- Main content still begins at `x = 319px` and uses the same `main-surface`.
- Header height remains `46px`.
- Content column is centered with `max-width` around `736px`.
- Catalog sections use transparent backgrounds and `gap-4`.
- Section examples:
  - Featured/plugin rows: `x = 463`, `width = 736`.
  - Vertical section gaps are large enough that categories read as separate bands without card wrappers.

Header tabs/actions on the Plugins page:

- Header text includes `Plugins`, `Skills`, `Manage`, `Create`.
- These are compact header controls rather than large tabs.
- They inherit the same 28px control language as toolbar buttons.

Plugin detail rows/cards:

- Plugin settings pages use bordered list cards rather than heavy panels.
- Example Computer Use plugin row:
  - Rect: `672px x 62px`.
  - Radius: `12.5px`.
  - Border: `1px rgba(255, 255, 255, 0.082)`.
  - Class pattern: `border-token-border/40 flex flex-col gap-2.5 rounded-2xl border p-2.5 transition`.
- Action button such as `Try in Chat`:
  - Size: `28px x 28px`.
  - Radius: `10px`.
  - Transparent background and transparent reserved border.

## Automations

The Automations screen introduces rounded prompt/template cards.

Page layout:

- Header action: `New automation`, white filled button.
- Content header column: `x = 447`, `width = 768`, with `px-panel`.
- Template section width: `728px`.
- Template sections use `flex flex-col gap-4`.

Automation template cards:

- Card width: `356px`.
- Card height: usually `97px`; shorter cards can be `78px`.
- Two-column grid inside the `728px` content column.
- Background: `oklab(0.297161 0.0000135154 0.00000594556 / 0.672549)`.
- Border: `1px oklab(0.999994 0.0000455678 0.0000200868 / 0.0411765)`.
- Radius: `30px` (`rounded-4xl`).
- Padding class: `px-3 py-3`.
- Text size: `13px`, line-height `19.5px`.
- Hover classes strengthen the card: `hover:border-token-border` and `hover:bg-token-input-background`.

This is the largest radius observed in normal content cards. It is used for selectable prompt templates, not ordinary panels.

## Account Popover

Clicking the sidebar `Settings` row first opens an account popover near the lower-left sidebar.

Measured popover:

- Rect: `x = 8`, `y = 663`, `width = 282`, `height = 176`.
- It contains account identity, account type, settings, rate limits, and log out.
- The popover itself is visually transparent in computed background, relying on internal menu structure and separators.
- Separators:
  - Width: `256px`.
  - Height: `1px`.
  - Background: `rgba(255, 255, 255, 0.082)`.
  - Class: `bg-token-menu-border`.

This popover confirms menu separators use the same low-contrast border color as split-button borders.

## Settings Shell

The actual Settings surface is a separate app state with a fixed left settings nav and a right content panel.

Settings nav:

- Nav width: `300px`.
- Nav starts below toolbar at `y = 46px`.
- Nav padding class: `px-row-x`.
- Row width: `284px`.
- Row height: `30px`.
- Row padding uses the same `px-row-x py-row-y` token pair as main sidebar rows.
- Row radius: `12.5px`.
- Row text: `12px`, line-height `17.1429px`.
- Active background: `rgba(255, 255, 255, 0.08)`.
- Items observed:
  - General
  - Appearance
  - Configuration
  - Personalization
  - MCP servers
  - Git
  - Environments
  - Worktrees
  - Browser use
  - Computer use
  - Archived chats
  - Usage

Settings content:

- Content starts at `x = 300px`.
- Top header strip: `height = 46px`.
- Scroll panel: `x = 300`, `y = 46`, `width = 1044`, `height = 831`.
- Content class: `flex-1 overflow-y-auto p-panel`.
- Inner content column:
  - Usually `x = 486`.
  - Width: `672px`.
  - Header block height: `67px`.
  - Section group gap: `var(--padding-panel)`.

Settings headings are plain text blocks, not cards. Most settings sections are transparent rows and sections; controls provide the visual weight.

## Settings: General

General contains work-mode cards, switches, dropdown buttons, and segmented controls.

Work mode cards:

- Two side-by-side cards.
- Each card: `330px x 284px`.
- Radius: `12.5px`.
- Selected background: `rgba(255, 255, 255, 0.08)`.
- Unselected background: `rgb(24, 24, 24)`.
- Unselected border: `1px rgba(255, 255, 255, 0.082)`.
- Class pattern: `cursor-interaction flex min-h-[284px] w-full min-w-0 flex-col items-center`.

Switches:

- Switch button size: `32px x 20px`.
- Text around switches uses `12px`.
- Switch buttons report transparent background at the outer button level; the visual track/thumb is inside child elements.
- Focus class: `focus-visible:ring-2`.
- Aria labels carry the setting names, for example:
  - `Default permissions are always shown`
  - `Show Auto-review in the composer`
  - `Show Full access in the composer`
  - `Prevent sleep while running`
  - `Enable ambient suggestions`
  - `Enable permission notifications`
  - `Enable question notifications`

Dropdown/select-like buttons:

- Width: often `240px`.
- Height: `28px`.
- Radius: `12.5px`.
- Background: `oklab(0.999994 0.0000455678 0.0000200868 / 0.05)`.
- Border is reserved but transparent: `1px rgba(0, 0, 0, 0)`.
- Text size: `13px`, line-height `18px`.
- Examples: `VS Code`, `Auto Detect`, `Standard`, `Only when unfocused`.

Small action buttons:

- `Set` buttons are `38px x 28px`.
- Same radius/background/font as dropdown buttons.

Segmented pills:

- Height: `24px`.
- Radius: `9999px`.
- Text size: `12px`, line-height `18px`.
- Selected background: `oklab(0.999994 0.0000455678 0.0000200868 / 0.05)`.
- Unselected background: transparent.
- Examples: `Queue` / `Steer`, `Inline` / `Detached`.

## Settings: Appearance

Appearance adds theme segmented controls, theme import/copy actions, code theme select, swatches, and sliders.

Theme segmented control:

- Buttons: `Light`, `Dark`, `System`.
- Height: `24px`.
- Radius: `9999px`.
- Text size: `12px`, line-height `18px`.
- Selected `Dark` background: `oklab(0.999994 0.0000455678 0.0000200868 / 0.05)`.
- Unselected buttons are transparent.

Theme actions:

- `Import`: `58px x 28px`.
- `Copy theme`: `91px x 28px`.
- Radius: `12.5px`.
- Transparent background and transparent reserved border.
- Text size: `13px`, line-height `18px`.

Code theme selector:

- Example: `Aa Codex`.
- Size: `240px x 28px`.
- Background: `oklab(0.999994 0.0000455678 0.0000200868 / 0.05)`.
- Radius: `12.5px`.
- Box shadow includes a tiny `0 1px 2px -1px rgba(0,0,0,0.08)`.

Color swatches:

- Small swatch buttons measured at `14px x 14px`.
- Background color carries the swatch value, for example accent green/blue.
- Swatches are much smaller than toolbar buttons and are embedded in rows.

## Settings: Plugin Panels

Browser Use and Computer Use settings use the same plugin panel pattern:

- Header block: transparent, `672px` wide.
- Section groups are transparent and stacked with `var(--padding-panel)`.
- Plugin summary cards use:
  - `border-token-border/40`
  - `rounded-2xl`
  - `border`
  - `p-2.5`
  - `gap-2.5`
  - `transition`
- Try/action icon button:
  - `28px x 28px`.
  - Radius: `10px`.
  - Transparent background and transparent reserved border.

This is a quieter, smaller card style than Automation templates.

## Settings: Archived Chats

Archived chats is a list surface:

- Content column: `672px`.
- List section uses `flex flex-col gap-2`.
- Rows are transparent sections rather than cards.
- Row actions use standard 28px buttons.
- `Unarchive` button:
  - Size: `79px x 28px`.
  - Background: `oklab(0.999994 0.0000455678 0.0000200868 / 0.05)`.
  - Radius: `12.5px`.
  - Text size: `13px`, line-height `18px`.
  - Transparent reserved border.

## Settings: Usage

Usage uses transparent sections with progress/limit content and standard actions.

Observed sections:

- `General usage limits`
- `GPT-5.3-Codex-Spark usage limits`
- `Credit`

Section layout:

- Section width: `672px`.
- Usage limit sections measured `672px x 173px`.
- Credit section measured `672px x 189px`.
- Sections are transparent; progress values and row text provide structure.

Actions:

- `Purchase`: `74px x 28px`.
- `Settings`: `68px x 28px`.
- Background: `oklab(0.999994 0.0000455678 0.0000200868 / 0.05)`.
- Radius: `12.5px`.
- Text size: `13px`, line-height `18px`.

Links:

- Links can use muted secondary text rather than blue when they are ancillary.
- Example `Doc`: `text-token-text-secondary hover:text-token-text-primary`.

## Practical Replication Rules

1. Use semantic tokens/classes first: foreground, description foreground, border, list hover, fog, input background.
2. Keep controls compact: `28px` for toolbar/composer controls, `30px` for nav rows.
3. Reserve border space with transparent borders to avoid hover layout shift.
4. Use `12.5px` radii for rows and split controls; use full pill radius for composer footer controls.
5. Use gradients only for resize handles, overflow fades, or masks.
6. Use `0.5px` translucent rings for major surfaces instead of strong 1px borders.
7. Keep text at `12px` or `13px` for operational UI.
8. Use `min-w-0`, `truncate`, and mask fades anywhere row actions can overlap labels.
9. Use `30px` radius only for large selectable prompt/template cards.
10. In settings, keep the content column at about `672px` and let controls carry the visual framing.
