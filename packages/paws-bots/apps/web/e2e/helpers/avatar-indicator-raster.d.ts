/** Types for the plain-JS raster helper Playwright injects into the page. */
export function auditIndicatorBounds(options: { theme: string; activity: string }): Promise<{
  theme: string;
  activity: string;
  actors: number;
  sizes: number[];
  colours: string[];
  frames: number;
  visiblePixels: number;
  outsidePixels: number;
  maxExcessAlpha: number;
  maxAlphaOnEmptyMask: number;
  safeOutsideSurface: number;
  detailForcedVisible: boolean;
}>;
