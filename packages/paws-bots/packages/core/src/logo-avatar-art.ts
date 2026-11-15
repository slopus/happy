import { botEyeColor } from "@rakazo/ui-tokens";
import type { AvatarEyes } from "./avatar-shape.js";
import { contrastRatio } from "./bot-avatar-colors.js";

export const LOGO_AVATAR_VIEWBOX = "0 0 100 100";

/** The body (and the eyes on it) sits this far down its plate. */
export const LOGO_AVATAR_BODY_Y = 9;

/** Oval eyes, in the body's own coordinates. */
export const LOGO_AVATAR_EYES: AvatarEyes = {
  width: 10.4,
  height: 16,
  leftCx: 40.5,
  rightCx: 59.5,
  cy: 40,
};

/** Dark eyes while they read on the body, otherwise whichever page color contrasts more. */
export function logoAvatarEyeInk(
  bodyColor: string,
  page: { background: string; foreground: string },
): string {
  if (contrastRatio(bodyColor, botEyeColor) >= 3.5) return botEyeColor;
  return contrastRatio(bodyColor, page.foreground) >= contrastRatio(bodyColor, page.background)
    ? page.foreground
    : page.background;
}

/** Smooth cubic fit to the canonical silhouette; no raster image is embedded. */
export const LOGO_BODY_PATH =
  "M-1.759 76.330C0.959 69.782 7.117 63.647 10.602 56.566C14.086 49.486 14.898 41.460 17.063 33.747C19.227 26.034 22.744 18.634 28.465 13.175C34.186 7.716 42.110 4.197 50.032 4.183C57.954 4.169 65.874 7.660 71.581 13.121C77.288 18.582 80.783 26.014 82.945 33.732C85.107 41.449 85.935 49.451 89.402 56.543C92.869 63.634 98.975 69.814 101.767 76.305L108 108H-8Z";
export const LOGO_LEFT_HAND_PATH = "M-2 74C7 68 22 75 26 83C31 93 26 102 19 107H-2Z";
export const LOGO_RIGHT_HAND_PATH = "M102 73C92 68 78 75 74 83C69 93 74 102 81 107H102Z";

/** Shared vector paint palette for web SVG and react-native-svg. */
export function logoAvatarPaint(hex: string, originalOrange = false) {
  const full = hex.length === 4 ? `#${[...hex.slice(1)].map((c) => c + c).join("")}` : hex;
  const raw = originalOrange ? "#ff7b08" : full;
  const rgb = [1, 3, 5].map((i) => Number.parseInt(raw.slice(i, i + 2), 16));
  const shade = (factor: number) =>
    `#${rgb
      .map((v) =>
        Math.max(0, Math.min(255, Math.round(v * factor)))
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")}`;
  return {
    base: shade(1),
    light: shade(1.12),
    mid: shade(1),
    shadow: shade(0.8),
    edge: shade(0.96),
    deep: shade(0.55),
    flank: originalOrange ? "#c14d08" : shade(0.58),
    contact: originalOrange ? "#961b00" : shade(0.42),
    rim: originalOrange
      ? "#fff1dc"
      : `#${rgb
          .map((v) =>
            Math.round(v + (255 - v) * 0.9)
              .toString(16)
              .padStart(2, "0"),
          )
          .join("")}`,
  };
}

/** Shared, directional surface lighting for web and native SVG bodies. */
export const LOGO_AVATAR_LIGHTING = {
  body: { cx: "57%", cy: "30%", r: "76%" },
  flank: {
    gradientUnits: "userSpaceOnUse",
    cx: 0,
    cy: 0,
    r: 1,
    gradientTransform: "matrix(45 0 0 44 0 32)",
  },
  crown: {
    gradientUnits: "userSpaceOnUse",
    cx: 0,
    cy: 0,
    r: 1,
    gradientTransform: "matrix(34 0 0 33 57 23.5)",
    peak: 0.28,
    shoulder: 0.12,
  },
  leftHand: { cx: "60%", cy: "35%", r: "76%" },
  rightHand: { cx: "40%", cy: "35%", r: "76%" },
  leftContact: {
    gradientUnits: "userSpaceOnUse",
    cx: 0,
    cy: 0,
    r: 1,
    gradientTransform: "matrix(7.5 0 0 17 24.5 91)",
  },
  rightContact: {
    gradientUnits: "userSpaceOnUse",
    cx: 0,
    cy: 0,
    r: 1,
    gradientTransform: "matrix(7.5 0 0 17 75.5 91)",
  },
  rimUpper: {
    gradientUnits: "userSpaceOnUse",
    cx: 0,
    cy: 0,
    r: 1.1,
    gradientTransform: "matrix(35.3494 0 0 45.3948 50.0193 49.4219)",
  },
  rimLeftTrim: {
    gradientUnits: "userSpaceOnUse",
    cx: 0,
    cy: 0,
    r: 1,
    gradientTransform: "matrix(8.4 0 0 10.5 36 19)",
  },
  rimLeft: {
    gradientUnits: "userSpaceOnUse",
    cx: 0,
    cy: 0,
    r: 1.1,
    gradientTransform: "matrix(66.2501 0 0 63.0879 -50 30.676)",
  },
  rimRight: {
    gradientUnits: "userSpaceOnUse",
    cx: 0,
    cy: 0,
    r: 1.1,
    gradientTransform: "matrix(66.2472 0 0 63.3467 150 30.5562)",
  },
  handLight: { leftPeak: 0.15, rightPeak: 0.24, radius: "62%" },
} as const;
