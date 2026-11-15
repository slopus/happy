import { pageTileBars } from "@rakazo/ui-tokens";

/** The page tile shown in a page card's footer. */
export function PageTileIcon() {
  return (
    <svg aria-hidden="true" width="33" height="41" viewBox="0 0 33 41" className="shrink-0">
      <rect
        x="0.25"
        y="0.25"
        width="32.5"
        height="40.5"
        rx="7"
        fill="var(--page-tile)"
        stroke="var(--page-tile-edge)"
        strokeWidth="0.5"
      />
      <rect x="4.5" y="4.5" width="23.5" height="3.5" rx="1.75" fill="var(--page-tile-line)" />
      <rect x="4.5" y="11.5" width="10.5" height="3.5" rx="1.75" fill="var(--page-tile-line)" />
      {[
        [4.5, 28.5],
        [11, 28.5],
        [18, 24.5],
        [24.5, 18.5],
      ].map(([x, y], i) => (
        <rect
          key={x}
          x={x}
          y={y}
          width="3.5"
          height={36 - (y ?? 0)}
          rx="1.75"
          fill={pageTileBars[i]}
        />
      ))}
    </svg>
  );
}
