import { pageKitPalette } from "@rakazo/ui-tokens";
// Charts and data display. Kept apart from the base kit styles so each family reads on its own.
export const DATAVIZ_CSS = `
:root{--rk-axis:color-mix(in srgb,var(--foreground) 58%,transparent);--rk-hover:color-mix(in srgb,var(--foreground) 4%,transparent);--rk-hover-strong:color-mix(in srgb,var(--foreground) 12%,transparent);--rk-line-strong:color-mix(in srgb,var(--foreground) 30%,transparent);--rk-hairline-soft:color-mix(in srgb,var(--foreground) 6%,transparent);--rk-fill-strong:${pageKitPalette.dark.fillStrong};--rk-surface:color-mix(in srgb,var(--foreground) 7%,var(--background))}
[data-theme="light"]{--rk-fill-strong:${pageKitPalette.light.fillStrong};--rk-surface:var(--background)}
.rk-chart{position:relative}
.rk-frame{padding:1.25rem;border:1px solid var(--rk-line);border-radius:16px}
:is(.rk-section[data-card],.rk-grid>*,.rk-frame) .rk-frame{padding:0;border:0;border-radius:0}
.rk-axis-arrow{display:inline-block;width:.7rem;height:.7rem;margin-inline-start:.25rem;vertical-align:-.05rem;fill:none;stroke:currentColor;stroke-width:1.2;stroke-linecap:round;stroke-linejoin:round}
.rk-bar[data-negative] .rk-bar-fill{background:var(--rk-negative)}
.rk-bar[data-negative] .rk-bar-value{color:var(--rk-danger)}
.rk-sort-mark{width:.7rem;height:.7rem;fill:none;stroke:currentColor;stroke-width:1.3;stroke-linecap:round;stroke-linejoin:round}
.rk-sort-mark[data-down]{transform:rotate(180deg)}
.rk-delta-arrow{width:.5rem;height:.5rem;fill:currentColor;align-self:center}
.rk-table[data-wide] td:first-child{min-width:8rem}
.rk-tone-success.rk-tone-success{color:var(--rk-success)}
.rk-tone-warning.rk-tone-warning{color:var(--rk-warning)}
.rk-tone-danger.rk-tone-danger{color:var(--rk-danger)}
.rk-tone-accent.rk-tone-accent{color:var(--rk-accent)}
.rk-rows[data-leads]{display:grid;grid-template-columns:auto minmax(0,1fr) auto}
.rk-rows[data-leads] .rk-row{grid-column:1/-1;grid-template-columns:subgrid}
.rk-plot{position:relative}
.rk-chart svg text{font-family:var(--rk-font)}
.rk-tick{fill:var(--rk-axis);font-size:12px;letter-spacing:.01em;font-variant-numeric:tabular-nums}
.rk-grid-line{stroke:var(--rk-hairline-soft);shape-rendering:crispEdges}
.rk-key{margin:0;padding:0;list-style:none;display:flex;flex-wrap:wrap;gap:.25rem 1rem;font-size:.75rem;line-height:1rem;letter-spacing:.01em;color:var(--rk-secondary)}
.rk-key-item{display:inline-flex;align-items:center;gap:.375rem;min-width:0}
.rk-key-dot{flex:none;width:8px;height:8px;border-radius:50%}
.rk-key-dot[data-small]{width:6px;height:6px}
.rk-chart .rk-key-line{display:block;flex:none;width:14px;height:2px;overflow:visible}
.rk-chart>.rk-key+*{margin-top:-.15rem}
.rk-column-value{fill:var(--rk-axis);font-size:12px;letter-spacing:.01em;font-variant-numeric:tabular-nums}
[data-emphasis] .rk-column-value,[data-emphasis] .rk-column-label{fill:var(--foreground);font-weight:500}
.rk-reference-line{stroke:var(--rk-secondary);stroke-dasharray:3 3;shape-rendering:crispEdges}
.rk-reference-label{fill:var(--rk-secondary);font-size:12px;font-weight:500;paint-order:stroke;stroke:var(--background);stroke-width:4px;stroke-linejoin:round}
.rk-trend{stroke:var(--rk-tertiary);stroke-width:1.5;stroke-dasharray:4 3}
.rk-dot{stroke:var(--background);stroke-width:1}
.rk-outlier{fill:var(--rk-secondary);font-size:11.5px;paint-order:stroke;stroke:var(--background);stroke-width:3px;stroke-linejoin:round}
.rk-stacked{display:grid;grid-template-columns:fit-content(min(12rem,40%)) minmax(0,1fr);gap:.75rem .75rem;align-items:center;font-size:.8125rem;line-height:1.125rem;letter-spacing:.015em}
.rk-stacked-row{display:contents}
.rk-stacked-label{min-width:3rem;text-align:right;color:var(--rk-secondary);overflow-wrap:anywhere}
.rk-stacked-track{display:flex;align-items:center;gap:.5rem;min-width:0}
.rk-stacked-bar{display:flex;gap:2px;height:10px;min-width:2px}
.rk-stacked-part{display:block;min-width:2px;border-radius:2px}
.rk-stacked-part:first-child{border-radius:0 2px 2px 0}
.rk-stacked-value{flex:none;font-variant-numeric:tabular-nums;white-space:nowrap}
.rk-ramp{display:flex;align-items:center;gap:4px;font-size:.75rem;line-height:1rem;color:var(--rk-secondary)}
.rk-ramp-step{width:16px;height:10px;border-radius:2px}
.rk-heatmap-scroll,.rk-calendar-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;padding-bottom:2px}
.rk-heatmap{display:grid;grid-template-columns:max-content repeat(var(--rk-heat-columns),minmax(8px,3.375rem));gap:3px;font-size:.75rem;line-height:1rem;color:var(--rk-secondary);width:max-content;max-width:100%;min-width:0}
.rk-heatmap-column{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding-bottom:3px}
.rk-heatmap[data-thin] .rk-heatmap-column{overflow:visible}
.rk-heatmap-row{padding:6px 8px 0 0;max-width:9rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rk-heatmap-cell{height:27px;border-radius:4px;outline-offset:1px}
.rk-calendar{position:relative;display:flex;flex-direction:column;gap:1rem;min-width:0}
.rk-calendar-grid{display:grid;grid-template-columns:auto repeat(var(--rk-weeks),12px);grid-template-rows:16px repeat(7,12px);gap:3px;width:max-content;font-size:.6875rem;line-height:1rem;color:var(--rk-secondary)}
.rk-calendar-month{font-size:.75rem;white-space:nowrap;align-self:start;line-height:12px}
.rk-calendar-weekday{padding-right:5px;line-height:12px}
.rk-day{border-radius:2px}
.rk-day[data-active],.rk-heatmap-cell[data-active]{outline:2px solid var(--foreground);outline-offset:1px}
.rk-calendar-foot{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:.25rem 1rem;font-size:.75rem;line-height:1rem;color:var(--rk-secondary)}
.rk-venn svg{overflow:visible}
.rk-venn-set{fill-opacity:.24;stroke-width:1}
[data-theme="light"] .rk-venn-set{fill-opacity:.16}
.rk-venn-name{fill:var(--foreground);font-size:12px;font-weight:500}
.rk-venn-count{fill:var(--rk-secondary);font-size:12px;font-variant-numeric:tabular-nums}
.rk-venn-overlap{fill:var(--foreground);font-size:12px;font-weight:500;font-variant-numeric:tabular-nums}
.rk-matrix{display:flex;gap:.5rem;min-width:0}
.rk-chart svg[tabindex]{touch-action:pan-y}
.rk-matrix-y{display:flex;flex-direction:row;justify-content:space-between;width:1rem;writing-mode:vertical-rl;transform:rotate(180deg);font-size:.75rem;line-height:1rem;color:var(--rk-axis);white-space:nowrap;padding-bottom:1.5rem}
.rk-matrix-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:.5rem}
.rk-matrix-plot{position:relative;height:17rem;border:1px solid var(--rk-line);border-radius:10px;background:linear-gradient(var(--rk-line),var(--rk-line)) 50% 0/1px 100% no-repeat,linear-gradient(var(--rk-line),var(--rk-line)) 0 50%/100% 1px no-repeat}
.rk-matrix-quadrant{position:absolute;max-width:calc(50% - 1.5rem);font-size:.75rem;line-height:1rem;font-weight:500;color:var(--rk-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rk-matrix-quadrant[data-corner="0"]{left:.75rem;top:.625rem}
.rk-matrix-quadrant[data-corner="1"]{left:calc(50% + .75rem);top:.625rem}
.rk-matrix-quadrant[data-corner="2"]{left:.75rem;bottom:.5rem}
.rk-matrix-quadrant[data-corner="3"]{left:calc(50% + .75rem);bottom:.5rem}
.rk-matrix-point{position:absolute;display:flex;align-items:center;gap:5px;transform:translate(-5px,-50%);max-width:45%;font-size:.75rem;line-height:1rem;white-space:nowrap}
.rk-matrix-point[data-flip]{flex-direction:row-reverse;transform:translate(calc(-100% + 5px),-50%)}
.rk-matrix-dot{flex:none;width:10px;height:10px;border-radius:50%;background:var(--rk-c1);box-shadow:0 0 0 2px var(--background)}
.rk-matrix-point{z-index:1}
.rk-matrix-label{overflow:hidden;text-overflow:ellipsis;padding:0 .25rem;border-radius:4px;background:color-mix(in srgb,var(--background) 85%,transparent)}
.rk-matrix-x{display:flex;justify-content:space-between;gap:.75rem;font-size:.75rem;line-height:1rem;color:var(--rk-axis)}
.rk-stamp{display:inline-flex;flex-wrap:wrap;align-items:center;gap:.25rem .5rem;font-size:.75rem;line-height:1rem;letter-spacing:.01em;color:var(--rk-axis);font-variant-numeric:tabular-nums}
.rk-stamp-pill{padding:.0625rem .5rem;border-radius:999px;background:var(--rk-fill-strong);color:var(--rk-secondary)}
.rk-stamp-pill[data-error]{background:color-mix(in srgb,var(--rk-warning) 17%,transparent);color:var(--rk-warning)}
.rk-chart-empty{display:grid;place-items:center;min-height:5rem;border:1px dashed var(--rk-line);border-radius:12px;font-size:.8125rem;color:var(--rk-axis)}
.rk-tip{position:absolute;z-index:3;pointer-events:none;min-width:7rem;max-width:16rem;padding:.5rem .625rem;border-radius:10px;background:var(--rk-surface);border:1px solid var(--rk-line);box-shadow:0 6px 24px ${pageKitPalette.shared.tipShadow};font-size:.75rem;line-height:1.05rem;color:var(--foreground);font-variant-numeric:tabular-nums;transform:translate(-50%,calc(-100% - 10px));white-space:nowrap}
.rk-tip-title{margin-bottom:.2rem;color:var(--rk-secondary)}
.rk-tip-row{display:flex;align-items:center;gap:.4rem}
.rk-tip-row b{margin-left:auto;padding-left:.75rem;font-weight:500}
.rk-tip-swatch{flex:none;width:7px;height:7px;border-radius:50%}
.rk-crosshair{stroke:var(--rk-line);stroke-width:1;shape-rendering:crispEdges}
.rk-focus-ring:focus-visible{outline:2px solid var(--ring);outline-offset:4px;border-radius:6px}
.rk-chart [data-dim]{opacity:.45;transition:opacity .14s}
@media (prefers-reduced-motion:no-preference){
.rk-draw{stroke-dasharray:1;stroke-dashoffset:1;animation:rk-draw .7s cubic-bezier(.16,1,.3,1) forwards}
}
@keyframes rk-draw{to{stroke-dashoffset:0}}
@media (max-width:720px){
.rk-matrix-plot{height:14rem}
}
@media print{
:root,[data-theme]{--rk-fill-strong:${pageKitPalette.light.fillStrong};--rk-surface:${pageKitPalette.shared.paper}}
.rk-tip,.rk-table-filter,.rk-table-more button{display:none}
.rk-table-scroll{-webkit-mask-image:none;mask-image:none;max-height:none!important;overflow:visible}
.rk-draw{animation:none!important;stroke-dasharray:none;stroke-dashoffset:0}
.rk-heatmap-scroll,.rk-calendar-scroll{overflow:visible}
.rk-frame,.rk-matrix,.rk-calendar,.rk-venn,.rk-stacked{break-inside:avoid}
}
`;
