import type { WebColorTokens } from "@rakazo/ui-tokens";
import {
  cssVariableName,
  pageKitPalette,
  renderTokensCss,
  webLightTokens,
} from "@rakazo/ui-tokens";
import { CALENDAR_CSS } from "./calendar.js";
import { CONTROLS_CSS } from "./controls.js";
import { DATAVIZ_CSS } from "./dataviz-styles.js";
import { MEDIA_CSS } from "./media.js";
import { TEXT_KIT_CSS } from "./text.js";

// Print is always light: paper has no dark mode, and shadows print as grey smudges.
const printTokens = (Object.keys(webLightTokens) as (keyof WebColorTokens)[])
  .map((token) => `${cssVariableName(token)}:${webLightTokens[token]};`)
  .join("");

const palette = (tones: (typeof pageKitPalette)["dark" | "light"]) =>
  Object.entries(tones)
    .map(([name, value]) => `--rk-${name}:${value};`)
    .join("");
const DARK_PALETTE = palette(pageKitPalette.dark);
const LIGHT_PALETTE = palette(pageKitPalette.light);

// Sizes are in rem so the whole page steps up together on wide screens.
const KIT_CSS = `
*,*::before,*::after{box-sizing:border-box}
:root{--rk-font:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,"Helvetica Neue",sans-serif;--rk-secondary:color-mix(in srgb,var(--foreground) 60%,transparent);--rk-tertiary:color-mix(in srgb,var(--foreground) 40%,transparent);--rk-line:color-mix(in srgb,var(--foreground) 15%,transparent);--rk-hairline:color-mix(in srgb,var(--foreground) 9%,transparent);--rk-track:color-mix(in srgb,var(--foreground) 8%,transparent);--rk-fill:color-mix(in srgb,var(--foreground) 7%,transparent);${DARK_PALETTE}}
[data-theme="light"]{${LIGHT_PALETTE}--rk-secondary:color-mix(in srgb,var(--foreground) 64%,transparent);--rk-on-c5:${pageKitPalette.shared.onDeepTone}}
:root{--rk-on-c1:${pageKitPalette.shared.onTone};--rk-on-c2:${pageKitPalette.shared.onTone};--rk-on-c3:${pageKitPalette.shared.onTone};--rk-on-c4:${pageKitPalette.shared.onTone};--rk-on-c5:${pageKitPalette.shared.onTone}}
html{font-size:16px}
html,body{margin:0;background:var(--background);color:var(--foreground);font-family:var(--rk-font);line-height:1.5;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;text-rendering:optimizeLegibility;-webkit-text-size-adjust:100%}
body{font-size:1rem}
.rk-page{max-width:calc(700px + 6rem);margin:0 auto;padding:2.25rem 3rem calc(2.5rem + var(--rk-bottom-inset,0px));display:flex;flex-direction:column;gap:1rem}
.rk-page[data-width="wide"]{max-width:calc(1280px + 6rem)}
.rk-page[data-width="full"]{max-width:none}
.rk-header{display:flex;flex-direction:column;gap:.75rem;margin-bottom:1.75rem}
.rk-title{margin:0;font-size:1.875rem;line-height:1.2;font-weight:600;letter-spacing:-0.012em;overflow-wrap:anywhere}
.rk-summary{margin:0;font-size:1rem;line-height:1.5}
.rk-section{min-width:0;display:flex;flex-direction:column;gap:0.9rem}
.rk-page>.rk-section{margin-bottom:.5rem}
.rk-page>:not(.rk-header)+.rk-section[data-headed]{margin-top:1.25rem}
.rk-section-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:0.6rem 1.2rem}
.rk-actions{display:flex;flex-wrap:wrap;align-items:flex-end;gap:.5rem 1rem}
.rk-heading{margin:0;font-size:1.5rem;line-height:1.25;font-weight:500;letter-spacing:-0.01em}
.rk-section .rk-section .rk-heading{font-size:1.25rem}
.rk-section[data-card]{padding:1.125rem 1.125rem 1.25rem;border:1px solid var(--rk-line);border-radius:16px;gap:0.96rem}
.rk-section[data-card]>.rk-section-head .rk-heading{font-size:1rem;line-height:1.3;font-weight:600;letter-spacing:0}
.rk-caption{margin:-.4rem 0 0;font-size:.875rem;line-height:1.4;color:var(--rk-secondary)}
.rk-grid{display:grid;gap:1rem;align-items:stretch;grid-template-columns:repeat(var(--rk-columns),minmax(0,1fr))}
.rk-text{margin:0;font-size:1rem;line-height:1.5;overflow-wrap:anywhere}
.rk-link{color:var(--rk-accent);text-decoration:underline;text-decoration-color:color-mix(in srgb,currentColor 40%,transparent);text-underline-offset:2px;overflow-wrap:anywhere}
.rk-code{padding:.05em .3em;border-radius:4px;background:var(--rk-fill);font:.875em/1 ui-monospace,SFMono-Regular,Menlo,monospace}
.rk-callout{padding:.875rem 1rem;border-radius:12px;background:var(--rk-fill);font-size:1rem;line-height:1.5;overflow-wrap:anywhere}
.rk-callout p{margin:0}
.rk-callout-lead{font-weight:600}
.rk-callout[data-tone]{background:color-mix(in srgb,var(--rk-tone) 14%,transparent)}
.rk-callout[data-tone] .rk-callout-lead{color:var(--rk-tone)}
.rk-callout[data-tone="info"]{--rk-tone:var(--rk-accent)}
.rk-callout[data-tone="success"]{--rk-tone:var(--rk-success)}
.rk-callout[data-tone="warning"]{--rk-tone:var(--rk-warning)}
.rk-callout[data-tone="danger"]{--rk-tone:var(--rk-danger)}
.rk-metrics{display:grid;gap:1rem 1.75rem;grid-template-columns:repeat(auto-fit,minmax(max(min(100%,var(--rk-metric-min,7rem)),calc((100% - (var(--rk-columns) - 1) * 1.75rem) / var(--rk-columns))),1fr));padding-top:.5rem}
.rk-metric{min-width:0}
.rk-metric-value{font-size:1.5rem;line-height:1.875rem;font-weight:500;letter-spacing:-.016em;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.rk-metric-label{margin-top:.5rem;font-size:.875rem;line-height:1.25rem;letter-spacing:.006em}
.rk-metric-detail{margin-top:.25rem;font-size:.875rem;line-height:1.25rem;letter-spacing:.006em;color:var(--rk-secondary)}
.rk-delta{display:inline-flex;align-items:baseline;gap:.25rem;font-weight:500;font-variant-numeric:tabular-nums}
.rk-metric-detail-note{color:var(--rk-secondary)}
.rk-spark{display:block;width:100%;max-width:9rem;height:1.5rem;margin-top:.5rem;overflow:visible}
.rk-spark polyline{fill:none;stroke:var(--rk-c1);stroke-width:1.5;stroke-linejoin:round;stroke-linecap:round}
.rk-visually-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.rk-tone-success{color:var(--rk-success)}
.rk-tone-warning{color:var(--rk-warning)}
.rk-tone-danger{color:var(--rk-danger)}
.rk-tone-accent{color:var(--rk-accent)}
.rk-status{display:inline-flex;align-items:center;gap:.375rem;max-width:100%;padding:.125rem .5rem;border-radius:999px;background:var(--rk-fill-strong);font-size:.75rem;line-height:1rem;font-weight:500;letter-spacing:.01em;color:var(--rk-secondary);vertical-align:middle;white-space:nowrap}
.rk-status-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--rk-tertiary)}
.rk-status[class*="rk-tone-"]{background:color-mix(in srgb,currentColor 17%,transparent)}
.rk-status[class*="rk-tone-"] .rk-status-dot{background:currentColor}
.rk-status-text{min-width:0;overflow:hidden;text-overflow:ellipsis}
.rk-properties{display:grid;grid-template-columns:fit-content(40%) minmax(0,1fr);gap:.5rem .75rem;margin:0}
.rk-properties[data-card]{padding:1rem 1.125rem;border:1px solid var(--rk-line);border-radius:16px}
.rk-property{display:grid;grid-column:1/-1;grid-template-columns:subgrid;align-items:baseline;font-size:.875rem;line-height:1.25rem;letter-spacing:.006em}
.rk-property dt{min-width:6rem;color:var(--rk-secondary);overflow-wrap:anywhere}
.rk-property dd{margin:0;min-width:0;overflow-wrap:anywhere}
.rk-rows,.rk-checklist{margin:0;padding:0;list-style:none}
.rk-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:0 .75rem;align-items:start;padding:.625rem 0;border-top:1px solid var(--rk-hairline-soft)}
.rk-row-lead{max-width:33vw;color:var(--rk-axis);font-size:1rem;line-height:1.5rem;font-variant-numeric:tabular-nums}
.rk-row-main{min-width:0}
.rk-row-title{font-size:1rem;line-height:1.5rem;letter-spacing:.006em;overflow-wrap:anywhere}
.rk-row-status{font-weight:500;color:var(--rk-secondary)}
.rk-row-detail{font-size:.875rem;line-height:1.25rem;letter-spacing:.006em;color:var(--rk-secondary);overflow-wrap:anywhere}
.rk-row-meta{max-width:45vw;padding-top:.125rem;font-size:.875rem;line-height:1.25rem;color:var(--rk-axis);text-align:right;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.rk-steps{display:flex;flex-direction:column;gap:1rem;margin:0;padding:0;list-style:none}
.rk-step{display:flex;gap:.8rem;align-items:flex-start}
.rk-step-number{flex:none;display:grid;place-items:center;width:1.6rem;height:1.6rem;border-radius:50%;background:var(--rk-fill);font-size:.8125rem;font-weight:500;font-variant-numeric:tabular-nums;line-height:1}
.rk-step-title{font-size:1rem;line-height:1.6rem;font-weight:500}
.rk-step-detail{font-size:.875rem;line-height:1.45;color:var(--rk-secondary)}
.rk-checklist li{padding:.55rem 0;border-top:1px solid var(--rk-hairline)}
.rk-checklist li:first-child{border-top:0;padding-top:0}
.rk-check input{position:absolute;width:1px;height:1px;margin:0;opacity:0;pointer-events:none}
.rk-check{position:relative;display:flex;align-items:flex-start;gap:.65rem;font-size:1rem;line-height:1.45}
.rk-check-mark{flex:none;width:1.1rem;height:1.1rem;margin-top:.13rem;fill:none;stroke:var(--rk-tertiary);stroke-width:1.5}
.rk-check[data-done="true"] .rk-check-mark circle{fill:var(--rk-success);stroke:var(--rk-success)}
.rk-check[data-done="true"] .rk-check-mark path{stroke:var(--background);stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.rk-check[data-done="true"] .rk-check-text{color:var(--rk-secondary)}
.rk-check-meta{margin:.1rem 0 0 1.75rem;font-size:.8125rem;line-height:1.4;color:var(--rk-secondary)}
.rk-table-wrap{display:flex;flex-direction:column;gap:.5rem;min-width:0}
.rk-table-filter{align-self:flex-start;width:min(16rem,100%);height:1.75rem;padding:0 .625rem;border:1px solid var(--rk-line);border-radius:8px;background:transparent;color:inherit;font:inherit;font-size:.8125rem}
.rk-table-filter::placeholder{color:var(--rk-secondary)}
.rk-table-filter:focus-visible{outline:2px solid var(--ring);outline-offset:1px}
.rk-table-box{border:1px solid var(--rk-line);border-radius:12px;overflow:hidden}
.rk-section[data-card] .rk-table-box{border-radius:8px}
.rk-table-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;--rk-fade-start:${pageKitPalette.shared.mask};--rk-fade-end:${pageKitPalette.shared.mask};-webkit-mask-image:linear-gradient(to right,var(--rk-fade-start),${pageKitPalette.shared.mask} 2.5rem,${pageKitPalette.shared.mask} calc(100% - 2.5rem),var(--rk-fade-end));mask-image:linear-gradient(to right,var(--rk-fade-start),${pageKitPalette.shared.mask} 2.5rem,${pageKitPalette.shared.mask} calc(100% - 2.5rem),var(--rk-fade-end))}
.rk-table-scroll[data-fade-start]{--rk-fade-start:transparent}
.rk-table-scroll[data-fade-end]{--rk-fade-end:transparent}
.rk-table-scroll[data-long]{max-height:34rem;overflow-y:auto}
.rk-table-box:has(.rk-table-scroll:focus-visible){outline:2px solid var(--ring);outline-offset:2px}
.rk-table-scroll:focus-visible{outline:0}
.rk-table{width:100%;border-collapse:separate;border-spacing:0;font-size:.9375rem;line-height:1.375rem;letter-spacing:.006em}
.rk-table th,.rk-table td{padding:.5rem .625rem;border-left:1px solid var(--rk-line);border-top:1px solid var(--rk-line);text-align:left;vertical-align:middle}
.rk-table th{font-size:.875rem;line-height:1.25rem;font-weight:500;white-space:nowrap;border-top:0;background:var(--background)}
.rk-table-scroll[data-long] thead th{position:sticky;top:0;z-index:1;box-shadow:0 1px 0 var(--rk-line)}
.rk-table tr>:first-child{border-left:0}
.rk-table tbody tr:hover td{background:var(--rk-hover)}
.rk-table .rk-align-end{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.rk-table .rk-align-center{text-align:center}
.rk-table .rk-emphasis{font-weight:500}
.rk-table-none{color:var(--rk-axis);text-align:center!important}
.rk-sort{all:unset;display:inline-flex;align-items:center;gap:.25rem;cursor:pointer;border-radius:4px}
.rk-sort:focus-visible{outline:2px solid var(--ring);outline-offset:2px}
.rk-sort-mark{opacity:0;color:var(--rk-tertiary);transition:opacity .14s,transform .14s}
.rk-sort:hover .rk-sort-mark,.rk-sort-mark[data-on]{opacity:1}
.rk-table-more{display:flex;align-items:center;justify-content:space-between;gap:1rem;font-size:.8125rem;color:var(--rk-secondary)}
.rk-table-more button{height:1.75rem;padding:0 .75rem;border:0;border-radius:8px;background:var(--rk-fill-strong);color:var(--foreground);font:inherit;cursor:pointer}
.rk-table-more button:hover{background:var(--rk-hover-strong)}
.rk-table-more button:focus-visible{outline:2px solid var(--ring);outline-offset:2px}
.rk-segmented{display:flex;flex-wrap:wrap;align-self:flex-start;max-width:100%;gap:.3rem .85rem}
.rk-segmented{min-width:0;margin:0;padding:0;border:0;display:flex;flex-wrap:wrap;align-self:flex-start;max-width:100%;gap:16px}
.rk-segmented button{appearance:none;display:block;border:0;margin:0;padding:0;background:transparent;color:var(--rk-secondary);font:inherit;font-size:13px;line-height:18px;letter-spacing:.195px;white-space:nowrap;cursor:pointer;transition:color .14s}
.rk-segment{display:inline-block;padding:2px 0;border-bottom:1px solid transparent;transition:border-color .14s}
.rk-segment-count{margin-left:5px;font-size:12px;line-height:16px;letter-spacing:.12px;color:var(--rk-secondary);font-variant-numeric:tabular-nums}
.rk-segmented button:hover{color:color-mix(in srgb,var(--foreground) 80%,transparent)}
.rk-segmented button[aria-pressed="true"]{color:var(--foreground);font-weight:500}
.rk-segmented button[aria-pressed="true"] .rk-segment{border-bottom-color:currentColor}
.rk-segmented button:focus-visible{outline:2px solid var(--ring);outline-offset:2px;border-radius:2px}
.rk-chart{display:flex;flex-direction:column;gap:.75rem;min-width:0}
.rk-chart svg{display:block;width:100%;overflow:visible}
.rk-line{fill:none;stroke:var(--rk-series,var(--rk-c1));stroke-width:2;stroke-linejoin:round;stroke-linecap:round}
.rk-line-dot{fill:var(--rk-series,var(--rk-c1))}
.rk-line-value{fill:var(--foreground);font-size:12px;font-weight:500;font-variant-numeric:tabular-nums}
.rk-line-secondary{fill:none;stroke:var(--rk-other);stroke-width:1.25;stroke-dasharray:3 3;stroke-linejoin:round}
.rk-line-area{fill:var(--rk-c1);fill-opacity:var(--rk-area)}
.rk-annotation line{stroke:var(--rk-line-strong)}
.rk-annotation circle{stroke:var(--background);stroke-width:1.5}
.rk-annotation text{fill:var(--rk-secondary);font-size:12px;paint-order:stroke;stroke:var(--background);stroke-width:3px;stroke-linejoin:round}
.rk-hover-dot{stroke:var(--background);stroke-width:2}
.rk-bars{display:grid;grid-template-columns:fit-content(min(14rem,40%)) minmax(0,1fr) auto;gap:.625rem .75rem;align-items:center;margin:0;padding:0;list-style:none;font-size:.8125rem;line-height:1.125rem;letter-spacing:.015em}
.rk-bar{display:contents}
.rk-bar-label{min-width:3rem;overflow-wrap:anywhere;color:var(--rk-secondary)}
.rk-bar[data-emphasis="true"] .rk-bar-label{color:var(--foreground)}
.rk-bar-value{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.rk-bar-track{height:6px;border-radius:999px;background:var(--rk-fill-strong);overflow:hidden}
.rk-bar-fill{display:block;height:100%;border-radius:999px;background:var(--rk-rest)}
.rk-bar[data-emphasis="true"] .rk-bar-fill{background:var(--rk-c1)}
.rk-pie{display:flex;flex-wrap:wrap;align-items:center;gap:1rem 1.5rem}
.rk-pie-ring{position:relative;flex:none;width:120px;height:120px}
.rk-pie svg{display:block;width:120px;height:120px}
.rk-pie-total{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;pointer-events:none}
.rk-pie-total-figure{font-size:.875rem;line-height:1.25rem;font-weight:500;font-variant-numeric:tabular-nums}
.rk-pie-total-label{font-size:.75rem;line-height:1rem;color:var(--rk-axis)}
.rk-pie-legend{display:flex;flex-direction:column;gap:.375rem;margin:0;padding:0;list-style:none;font-size:.8125rem;line-height:1.125rem;letter-spacing:.015em}
.rk-pie-legend li{display:flex;align-items:baseline;gap:.5rem;font-variant-numeric:tabular-nums;color:var(--rk-secondary)}
.rk-pie-legend li::before{content:"";flex:none;align-self:center;width:8px;height:8px;border-radius:50%;background:var(--rk-swatch)}
.rk-pie-legend li[data-emphasis] .rk-pie-value{color:var(--foreground);font-weight:500}
.rk-pie-share{color:var(--rk-axis)}
.rk-diagram{overflow-x:auto;-webkit-overflow-scrolling:touch}
.rk-diagram svg{display:block;width:100%;height:auto;overflow:visible}
.rk-diagram-node{fill:var(--background);stroke:var(--rk-line);stroke-width:1.25}
.rk-diagram-label{fill:var(--foreground);font-size:14px;font-weight:500}
.rk-diagram-detail{fill:var(--rk-secondary);font-size:12.5px}
.rk-diagram-edge{fill:none;stroke:var(--rk-tertiary);stroke-width:1.5}
.rk-diagram-arrow{fill:none;stroke:var(--rk-tertiary);stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
.rk-diagram-edge-label{fill:var(--rk-secondary);font-size:12px;paint-order:stroke;stroke:var(--background);stroke-width:5px;stroke-linejoin:round}
.rk-sources{margin-top:1.5rem;padding-top:1rem;border-top:1px solid var(--rk-hairline);font-size:.8125rem;line-height:1.5;color:var(--rk-secondary)}
.rk-sources-heading{margin:0 0 .3rem;font-size:.8125rem;font-weight:500;color:var(--foreground)}
.rk-sources ol{margin:0;padding-left:1.2rem}
.rk-error{width:100%;max-width:640px;margin:0 auto;padding:1rem 1.2rem;border:1px solid var(--rk-line);border-radius:12px}
.rk-error-title{margin:0 0 .4rem;font-size:1rem;font-weight:600}
.rk-error pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font:.8rem/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--rk-secondary)}
@media (min-width:721px){[data-touch] .rk-page{padding:2rem 2rem calc(2.5rem + var(--rk-bottom-inset,0px))}[data-touch] .rk-header{margin-bottom:1.5rem}[data-touch] .rk-properties{gap:.52rem}}
@media (max-width:720px){
.rk-page{padding:1.5rem 1rem calc(2rem + var(--rk-bottom-inset,0px));gap:.75rem}
.rk-header{gap:.5rem;margin-bottom:.75rem}
.rk-title{font-size:1.625rem}
.rk-heading{font-size:1.25rem}
.rk-page>.rk-section{margin-bottom:0}
.rk-page>:not(.rk-header)+.rk-section[data-headed]{margin-top:1rem}
.rk-section[data-card]{padding:1rem .875rem 1.125rem}
.rk-grid{grid-template-columns:minmax(0,1fr)}
.rk-properties{grid-template-columns:fit-content(45%) minmax(0,1fr)}
.rk-table th,.rk-table[data-wide] td{white-space:nowrap}
.rk-metrics{gap:1.25rem 1rem;--rk-columns:2!important}
}
@media print{
html{font-size:14px}
:root,[data-theme]{${printTokens}${LIGHT_PALETTE};color-scheme:light}
.rk-page{max-width:none;padding:0}
.rk-section[data-card],.rk-properties[data-card],.rk-table tr,.rk-chart,.rk-pie,.rk-diagram,.rk-callout{break-inside:avoid}
.rk-heading{break-after:avoid}
}
`;

/**
 * The vertical rhythm inside a section, last so it wins over each block's own margin reset: a
 * heading holds its first block close, prose runs at reading distance, separate blocks get room,
 * and a nested section gets the most. Cards use the tighter set.
 */
const RHYTHM_CSS = `
.rk-section,.rk-section-body{gap:0;--rk-lead:.75rem;--rk-prose:1rem;--rk-block:1.25rem;--rk-sub:1.75rem}
.rk-section[data-card]{--rk-prose:.75rem;--rk-block:1rem;--rk-sub:1.25rem}
@media (max-width:720px){.rk-section,.rk-section-body{--rk-lead:.625rem;--rk-block:1rem;--rk-sub:1.5rem}.rk-section[data-card]{--rk-block:.875rem}}
:is(.rk-section,.rk-section-body)>*+*{margin-top:var(--rk-block)}
:is(.rk-section,.rk-section-body)>:is(.rk-text,.rk-list)+:is(.rk-text,.rk-list){margin-top:var(--rk-prose)}
:is(.rk-section,.rk-section-body)>:is(.rk-segmented,.rk-section-head)+*{margin-top:var(--rk-lead)}
:is(.rk-section,.rk-section-body)>.rk-caption[data-figure]{margin-top:.5rem}
:is(.rk-section,.rk-section-body)>*+.rk-section{margin-top:var(--rk-sub)}
.rk-section>.rk-section-head+.rk-section-fold:not([data-open]){margin-top:0}
`;

export const PAGE_STYLES = `${renderTokensCss()}\n${KIT_CSS}\n${TEXT_KIT_CSS}\n${DATAVIZ_CSS}\n${CONTROLS_CSS}\n${MEDIA_CSS}\n${CALENDAR_CSS}\n${RHYTHM_CSS}`;
