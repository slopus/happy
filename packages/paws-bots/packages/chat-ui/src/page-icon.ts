/**
 * The page icon in a 33 x 41 box: a sheet with a folded top-right corner, two lines and four
 * rising bars, coloured by the `pageIcon*` tokens and `pageIconBars`.
 */
export const PAGE_ICON = {
  width: 33,
  height: 41,
  radius: 5.5,
  /** The fold starts this far from the left and ends this far down the right edge. */
  foldX: 20.5,
  foldY: 12,
  lines: [
    { x: 5.5, y: 7.5, width: 12, height: 2.5, token: "pageIconLine" },
    { x: 5.5, y: 14, width: 14.5, height: 2.5, token: "pageIconLineSoft" },
  ],
  bars: [
    { x: 5.5, y: 27.5, height: 7.5 },
    { x: 11.5, y: 25.5, height: 9.5 },
    { x: 18, y: 22.5, height: 12 },
    { x: 24, y: 20, height: 15 },
  ],
  barWidth: 3.5,
} as const;
