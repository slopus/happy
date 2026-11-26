/**
 * DSH image-gen brand skin for the tldraw surface.
 *
 * Injected AFTER the bundled tldraw styles (tl-css.ts): it only re-declares
 * tldraw's own CSS variables and restyles tldraw's own chrome classes, scoped
 * to our canvas container, so upgrading tldraw never requires edits here. This
 * layer owns the UI chrome (panels, toolbars, hover/active feedback, grid
 * dots); colors painted onto the canvas itself (shape palette, selection
 * handles, marquee) come from the runtime theme patch in tl-brand-theme.ts.
 * Dark chrome keeps stock tldraw colors: the plugin lives in DSH's light shell.
 *
 * Beyond re-tinting, this pass reshapes tldraw's signature chrome so the
 * surface no longer reads as "stock tldraw": the grey corner strips (top-left
 * menu zone, bottom-left navigation) become floating white cards with hairline
 * borders, matching the workbench card language.
 */

import { BRAND_BLUE, BRAND_BLUE_RGB, BRAND_INK, CANVAS_BG, CANVAS_BG_BOTTOM, CANVAS_BG_TOP } from './tl-brand-tokens.js'

/** Hairline border used on every floating chrome card. */
const CARD_BORDER = '#d9e2f2'
/** Shadow used on every floating chrome card (workbench blue-grey family). */
const CARD_SHADOW = '0px 1px 2px rgba(30, 42, 76, 0.06), 0px 4px 12px rgba(30, 42, 76, 0.08)'

export const TL_THEME_CSS = `
/* DSH image-gen skin for the tldraw surface (light chrome only). */
.dsh-ig-tl-canvas .tl-container.tl-theme__light {
	/* Canvas surface: a clearly cool blue-grey board, distinguishable from the
	   pure-white floating cards at a glance. Same token feeds the runtime
	   theme patch (CANVAS_BG in tl-brand-theme.ts). */
	--tl-color-background: ${CANVAS_BG};
	--tl-color-grid: rgba(88, 110, 158, 0.5);

	/* Brand accents: selection outlines, active tool, chips, focus rings. */
	--tl-color-selected: ${BRAND_BLUE};
	--tl-color-primary: ${BRAND_BLUE};
	--tl-color-focus: ${BRAND_BLUE};
	--tl-color-selection-stroke: ${BRAND_BLUE};
	--tl-color-selection-fill: rgba(${BRAND_BLUE_RGB}, 0.14);

	/* Interaction feedback: hover chips and active-tool highlight are tinted
	   brand blue instead of tldraw's neutral grey-black. */
	--tl-color-hint: rgba(${BRAND_BLUE_RGB}, 0.14);
	--tl-color-muted-1: rgba(${BRAND_BLUE_RGB}, 0.14);
	--tl-color-muted-2: rgba(${BRAND_BLUE_RGB}, 0.07);

	/* Chrome: panels, borders, and text aligned with the workbench tokens. */
	--tl-color-panel: #ffffff;
	--tl-color-panel-contrast: #ffffff;
	--tl-color-low: #ffffff;
	--tl-color-low-border: ${CARD_BORDER};
	--tl-color-divider: #dfe6f3;
	--tl-color-text: ${BRAND_INK};
	--tl-color-text-0: ${BRAND_INK};
	--tl-color-text-1: #242f44;
	--tl-color-text-3: #6b7690;

	/* Shadows: the workbench's cold blue-grey instead of tldraw's black. */
	--tl-shadow-1: 0px 1px 2px rgba(30, 42, 76, 0.24), 0px 1px 3px rgba(30, 42, 76, 0.08);
	--tl-shadow-2:
		0px 0px 2px rgba(30, 42, 76, 0.14), 0px 2px 3px rgba(30, 42, 76, 0.2),
		0px 2px 6px rgba(30, 42, 76, 0.08), inset 0px 0px 0px 1px var(--tl-color-panel-contrast);
	--tl-shadow-3:
		0px 1px 2px rgba(30, 42, 76, 0.24), 0px 2px 6px rgba(30, 42, 76, 0.12),
		inset 0px 0px 0px 1px var(--tl-color-panel-contrast);
	--tl-shadow-4:
		0px 0px 3px rgba(30, 42, 76, 0.16), 0px 5px 4px rgba(30, 42, 76, 0.13),
		0px 2px 16px rgba(30, 42, 76, 0.05), inset 0px 0px 0px 1px var(--tl-color-panel-contrast);

	/* Noticeably rounder chrome than tldraw's stock 4/6/9/11px. */
	--tl-radius-1: 6px;
	--tl-radius-2: 10px;
	--tl-radius-3: 13px;
	--tl-radius-4: 16px;
}

/* ---------------------------------------------------------------
 * De-tldraw pass: reshape tldraw's signature corner strips and
 * floating chrome into the workbench's card language.
 * ------------------------------------------------------------- */

/* Canvas backdrop: subtle vertical gradient (light at top, a touch deeper at
   the bottom) for an airy, lit-from-above feel. Painted on the UI background
   layer ONLY — --tl-color-background stays a flat color because tldraw reuses
   it for export backgrounds and edge highlight lines, which must stay clean. */
.dsh-ig-tl-canvas .tl-container.tl-theme__light .tl-background {
	background-image: linear-gradient(180deg, ${CANVAS_BG_TOP} 0%, ${CANVAS_BG} 60%, ${CANVAS_BG_BOTTOM} 100%);
}

/* Top-left menu strip -> floating white card (Page menu + quick actions). */
.dsh-ig-tl-canvas .tl-container.tl-theme__light .tlui-menu-zone {
	margin: 10px;
	background-color: #ffffff;
	border: 1px solid ${CARD_BORDER};
	border-radius: 12px;
	box-shadow: ${CARD_SHADOW};
}

/* Bottom-left navigation strip -> floating white card (zoom, pages, minimap).
   Offsets detach it from the screen corner; the ::before paints the card. */
.dsh-ig-tl-canvas .tl-container.tl-theme__light .tlui-navigation-panel {
	left: 12px;
	bottom: 12px;
}
.dsh-ig-tl-canvas .tl-container.tl-theme__light[dir='rtl'] .tlui-navigation-panel {
	left: auto;
	right: 12px;
}
.dsh-ig-tl-canvas .tl-container.tl-theme__light .tlui-navigation-panel::before {
	inset: -6px -6px -6px -6px;
	background-color: #ffffff;
	border: 1px solid ${CARD_BORDER};
	border-radius: 12px;
	box-shadow: ${CARD_SHADOW};
}

/* Bottom toolbar pill -> bordered card so it matches the other cards. */
.dsh-ig-tl-canvas .tl-container.tl-theme__light .tlui-main-toolbar__tools {
	border: 1px solid ${CARD_BORDER};
}

/* Vertical left rail (Figma-style, set via components.Toolbar): float it off
   the screen edge like the other cards. Stock offsets (top 90px / bottom
   140px) already clear the top-left menu card and bottom-left minimap card. */
.dsh-ig-tl-canvas .tl-container.tl-theme__light .tlui-main-toolbar--vertical {
	left: 12px;
	padding-left: 0;
}

/* Compact rail buttons (40px instead of stock 48px) for an app-like density
   that differs from tldraw's chunky mobile-sized chrome. */
.dsh-ig-tl-canvas .tl-container.tl-theme__light .tlui-main-toolbar--vertical .tlui-button__tool {
	width: 40px;
	height: 40px;
}
.dsh-ig-tl-canvas .tl-container.tl-theme__light .tlui-main-toolbar--vertical .tlui-button__tool::after {
	inset: 3px;
	border-radius: 9px;
}
.dsh-ig-tl-canvas .tl-container.tl-theme__light .tlui-main-toolbar--vertical .tlui-main-toolbar__extras {
	width: 40px;
}

/* Right style panel -> bordered card. */
.dsh-ig-tl-canvas .tl-container.tl-theme__light .tlui-style-panel__wrapper {
	border: 1px solid ${CARD_BORDER};
}

/* Dropdown menus and popovers -> hairline border for definition. */
.dsh-ig-tl-canvas .tl-container.tl-theme__light .tlui-menu,
.dsh-ig-tl-canvas .tl-container.tl-theme__light .tlui-popover__content {
	border: 1px solid ${CARD_BORDER};
}

/* Active menu chips (e.g. style panel selections): brand tint instead of grey. */
.dsh-ig-tl-canvas .tl-container.tl-theme__light .tlui-button[data-isactive='true'] {
	color: ${BRAND_BLUE};
}
.dsh-ig-tl-canvas .tl-container.tl-theme__light .tlui-button[data-isactive='true']::after {
	background: rgba(${BRAND_BLUE_RGB}, 0.14);
}
`
