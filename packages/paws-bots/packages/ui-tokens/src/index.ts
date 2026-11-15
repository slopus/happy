export const APPEARANCE_PREFERENCES = ["system", "light", "dark"] as const;

export type AppearancePreference = (typeof APPEARANCE_PREFERENCES)[number];

export type ResolvedAppearance = "light" | "dark";

export const UI_APPEARANCE_STORAGE_KEY = "rakazo.uiAppearance";

/**
 * Semantic palette shared by web, Electron, and Expo. Names follow the shadcn
 * convention so the same slot means the same thing on every surface: a `border`
 * is always a border and never a fill.
 */
export type ColorTokens = {
  background: string;
  /** Modals: a step lighter than the page so they read as raised above it. */
  dialog: string;
  foreground: string;
  card: string;
  cardForeground: string;
  popover: string;
  popoverForeground: string;
  /** Fill and hairline where native Liquid Glass is unavailable (Android, iOS before 26). */
  glassFill: string;
  glassStroke: string;
  primary: string;
  primaryForeground: string;
  secondary: string;
  secondaryForeground: string;
  chatUser: string;
  /** White in both themes: the user bubble is a solid fill (light grey in dark, near-black in light). */
  chatUserForeground: string;
  muted: string;
  mutedForeground: string;
  /** Tertiary text: placeholders, list markers, quote bars, timestamps. */
  faintForeground: string;
  accent: string;
  accentForeground: string;
  /** Destructive text and outlines. */
  destructive: string;
  /** Solid destructive fill (Hang up, a filled Delete); its text is `destructiveForeground`. */
  destructiveFill: string;
  destructiveForeground: string;
  border: string;
  input: string;
  ring: string;
  sidebar: string;
  sidebarForeground: string;
  sidebarBorder: string;
  sidebarAccent: string;
  sidebarAccentForeground: string;
  link: string;
  /** Backing behind a link's site icon. White in both themes so dark logos stay visible on any bubble. */
  faviconPlate: string;
  success: string;
  warning: string;
  statusWorking: string;
  /** Unread dot. The one blue in the inbox, in both themes. */
  unread: string;
  /** Working dot on a busy bot's avatar. The one green, in both themes. */
  workingDot: string;
  overlay: string;
  scrollbar: string;
  scrollbarHover: string;
  /** The folded page icon a chat names a page with: its sheet, edge, fold and two text lines. */
  pageIconSheet: string;
  pageIconEdge: string;
  pageIconFold: string;
  pageIconLine: string;
  pageIconLineSoft: string;
  /** The rounded page tile on a page card's footer: fill, edge and its text lines. */
  pageTile: string;
  pageTileEdge: string;
  pageTileLine: string;
};

export const darkTokens = {
  background: "#141414",
  dialog: "#1E1E1E",
  foreground: "#FFFFFF",
  card: "#202020",
  cardForeground: "#FFFFFF",
  popover: "#202020",
  popoverForeground: "#FFFFFF",
  glassFill: "#2C2C2E",
  glassStroke: "#FCFCFC26",
  primary: "#FFFFFF",
  primaryForeground: "#000000",
  secondary: "#7676803D",
  secondaryForeground: "#FFFFFF",
  chatUser: "#5C5C5C",
  chatUserForeground: "#FFFFFF",
  muted: "#202020",
  mutedForeground: "#EBEBF599",
  faintForeground: "#EBEBF573",
  accent: "#78788052",
  accentForeground: "#FFFFFF",
  destructive: "#FF9592",
  destructiveFill: "#E5484D",
  destructiveForeground: "#FFFFFF",
  border: "#FCFCFC14",
  input: "#54545899",
  ring: "#3B82F6",
  sidebar: "#1E1E1E",
  sidebarForeground: "#FFFFFF",
  sidebarBorder: "#FCFCFC14",
  sidebarAccent: "#2B2B2E",
  sidebarAccentForeground: "#FFFFFF",
  link: "#459FFE",
  faviconPlate: "#FFFFFF",
  success: "#3FA266",
  warning: "#DB941E",
  statusWorking: "#459FFE",
  unread: "#006CEB",
  workingDot: "#3FA266",
  overlay: "rgba(0, 0, 0, 0.28)",
  scrollbar: "#1E2026",
  scrollbarHover: "#2E313A",
  pageIconSheet: "#2C2C2E",
  pageIconEdge: "#363638",
  pageIconFold: "#3C3C3E",
  pageIconLine: "#6F6F71",
  pageIconLineSoft: "#616163",
  pageTile: "#343434",
  pageTileEdge: "#414141",
  pageTileLine: "#626262",
} as const satisfies ColorTokens;

export const lightTokens = {
  background: "#FCFCFC",
  dialog: "#FFFFFF",
  foreground: "#000000",
  card: "#EFEFEF",
  cardForeground: "#000000",
  popover: "#FFFFFF",
  popoverForeground: "#000000",
  glassFill: "#FFFFFF",
  glassStroke: "#14141416",
  primary: "#000000",
  primaryForeground: "#FFFFFF",
  secondary: "#7676801F",
  secondaryForeground: "#000000",
  chatUser: "#0B0B0B",
  chatUserForeground: "#FFFFFF",
  muted: "#F2F2F1",
  mutedForeground: "#3C3C43B3",
  faintForeground: "#3C3C4394",
  accent: "#78788029",
  accentForeground: "#000000",
  destructive: "#CE2C31",
  destructiveFill: "#E5484D",
  destructiveForeground: "#FFFFFF",
  border: "#14141414",
  input: "#3C3C434A",
  ring: "#6C6C70",
  sidebar: "#F7F7F7",
  sidebarForeground: "#000000",
  sidebarBorder: "#14141414",
  sidebarAccent: "#FFFFFF",
  sidebarAccentForeground: "#000000",
  link: "#0C64C1",
  faviconPlate: "#FFFFFF",
  success: "#007041",
  warning: "#885A07",
  statusWorking: "#0C64C1",
  unread: "#006CEB",
  workingDot: "#3FA266",
  overlay: "rgba(0, 0, 0, 0.19)",
  scrollbar: "#C8C8C4",
  scrollbarHover: "#A8A8A4",
  pageIconSheet: "#E8E8EA",
  pageIconEdge: "#D6D6DA",
  pageIconFold: "#D0D0D4",
  pageIconLine: "#8E8E93",
  pageIconLineSoft: "#A1A1A6",
  pageTile: "#ECECEE",
  pageTileEdge: "#DADADD",
  pageTileLine: "#A1A1A6",
} as const satisfies ColorTokens;

/** Web and Electron only: the primary fill's hover and disabled states. Mobile has no hover. */
export type WebColorTokens = ColorTokens & {
  primaryHover: string;
  primaryDisabled: string;
};

/**
 * Web and Electron values for the tokens they draw differently from the palettes above, which
 * follow the iOS system design for mobile. Mobile reads `darkTokens` / `lightTokens`; web reads
 * `tokens.css`, rendered from these merged palettes. Surfaces are opaque; text, borders, hover
 * and selection are the ink at an opacity, so they read the same on every surface.
 */
export const webDarkOverrides = {
  background: "#0A0A0A",
  dialog: "#161616",
  foreground: "#F5F5F5",
  card: "#232323",
  cardForeground: "#F5F5F5",
  popover: "#232323",
  popoverForeground: "#F5F5F5",
  primary: "#F5F5F5",
  primaryHover: "#DBDBDB",
  primaryDisabled: "#F5F5F521",
  primaryForeground: "#121212",
  secondary: "#F5F5F50A",
  secondaryForeground: "#F5F5F5",
  chatUser: "#3E3E3E",
  chatUserForeground: "#F5F5F5",
  muted: "#232323",
  mutedForeground: "#F5F5F5A8",
  faintForeground: "#F5F5F58A",
  accent: "#F5F5F51A",
  accentForeground: "#F5F5F5",
  destructive: "#FF6463",
  destructiveFill: "#CF2B35",
  border: "#F5F5F51A",
  input: "#F5F5F538",
  ring: "#1884FC",
  sidebar: "#0A0A0A",
  sidebarForeground: "#F5F5F5",
  sidebarBorder: "#F5F5F50F",
  sidebarAccent: "#F5F5F514",
  sidebarAccentForeground: "#F5F5F5",
  link: "#4D9BFF",
  success: "#00BA69",
  warning: "#E28600",
  statusWorking: "#4D9BFF",
  unread: "#4D9BFF",
  workingDot: "#0E9F5A",
  overlay: "#000000B2",
  scrollbar: "#F5F5F538",
  scrollbarHover: "#F5F5F580",
} as const satisfies Partial<WebColorTokens>;

export const webLightOverrides = {
  background: "#FFFFFF",
  foreground: "#1C1C1C",
  card: "#F2F2F2",
  cardForeground: "#1C1C1C",
  popoverForeground: "#1C1C1C",
  primary: "#1C1C1C",
  primaryHover: "#363636",
  primaryDisabled: "#1C1C1C26",
  primaryForeground: "#FCFCFC",
  secondary: "#1C1C1C0F",
  secondaryForeground: "#1C1C1C",
  chatUser: "#1C1C1C",
  muted: "#F2F2F2",
  mutedForeground: "#1C1C1CAD",
  faintForeground: "#1C1C1C8F",
  accent: "#1C1C1C0F",
  accentForeground: "#1C1C1C",
  destructive: "#CD2834",
  destructiveFill: "#E72E3B",
  border: "#1C1C1C1F",
  input: "#1C1C1C3D",
  ring: "#1E86FC",
  sidebar: "#F5F5F5",
  sidebarForeground: "#1C1C1C",
  sidebarBorder: "#1C1C1C1F",
  sidebarAccent: "#1C1C1C14",
  sidebarAccentForeground: "#1C1C1C",
  link: "#0B6DD3",
  success: "#00854A",
  warning: "#AA6300",
  statusWorking: "#0B6DD3",
  unread: "#0B6DD3",
  workingDot: "#10AB61",
  overlay: "#00000080",
  scrollbar: "#1C1C1C3D",
  scrollbarHover: "#1C1C1C85",
} as const satisfies Partial<WebColorTokens>;

export const webDarkTokens: WebColorTokens = { ...darkTokens, ...webDarkOverrides };
export const webLightTokens: WebColorTokens = { ...lightTokens, ...webLightOverrides };

/** Dark palette. Prefer `tokensForAppearance` when theme-aware. */
export const tokens = darkTokens;

export const RADIUS = "0.75rem";

export const fontWeight = { regular: "400", medium: "500", semibold: "600" } as const;

/**
 * Native text styles on the system font, in points: iOS body text is 17/22. Titles use the
 * font's own line spacing, written out so they don't inherit a smaller body line height.
 */
export const typeScale = {
  title: { fontSize: 22, lineHeight: 26, fontWeight: fontWeight.semibold },
  headline: { fontSize: 19, lineHeight: 23, fontWeight: fontWeight.semibold },
  cardTitle: { fontSize: 17, lineHeight: 22, fontWeight: fontWeight.medium },
  body: { fontSize: 17, lineHeight: 22 },
  secondary: { fontSize: 15, lineHeight: 19 },
  caption: { fontSize: 14, lineHeight: 18 },
  footnote: { fontSize: 12, lineHeight: 16 },
} as const;

/**
 * Text grows with the iOS text size until body text reaches 23pt, the xxxLarge size. Larger
 * accessibility sizes keep that size, so message bubbles, rows and cards keep their layout.
 */
export const MAX_FONT_SCALE = 23 / typeScale.body.fontSize;

/**
 * The rising bars on the page icon, the same in both themes. The folded icon was measured from
 * the chat chip; the card footer's tile draws them a little brighter.
 */
export const pageIconBars = ["#489D61", "#E7712E", "#BC3B3D", "#3E82F3"] as const;
export const pageTileBars = ["#5AC078", "#E9993A", "#E87031", "#3E82F4"] as const;

/**
 * Bot-built pages: data series and status tones, a step deeper on white. Kept out of tokens.css
 * because only the sandboxed page document uses them, never the app's own chrome.
 */
export const pageKitPalette = {
  dark: {
    c1: "#1084FE",
    c2: "#FF9800",
    c3: "#00BCA6",
    c4: "#69D290",
    c5: "#E76265",
    rest: "#084382",
    area: ".24",
    other: "#777777",
    negative: "#FF263C",
    seq1: "#084382",
    seq2: "#0C64C1",
    seq3: "#1084FE",
    seq4: "#459FFE",
    seq5: "#80BEFE",
    success: "#38D591",
    warning: "#FFAF38",
    danger: "#FF5667",
    accent: "#459FFE",
    accentDeep: "#80befe",
    successDeep: "#78e2b4",
    warningDeep: "#ffc878",
    dangerDeep: "#ff8c98",
    div1: "#FF5667",
    div2: "#82131F",
    div3: "#262626",
    div4: "#084382",
    div5: "#459FFE",
    fillStrong: "rgba(119,119,119,.17)",
    cardSurface: "#181818",
    cardShadowNear: "#0006",
    cardShadowFar: "#0000004d",
    controlFill: "#7777772c",
    controlHoverFill: "#77777747",
    buttonFill: "#fafafa",
    buttonHoverFill: "#d5d5d5",
    buttonInk: "#141414",
    optionFill: "#181818",
    checkedFill: "#5a5a5a",
  },
  light: {
    c1: "#1084FE",
    c2: "#FF9800",
    c3: "#00BCA6",
    c4: "#009957",
    c5: "#C21D2E",
    rest: "#80BEFE",
    area: ".16",
    other: "#777777",
    negative: "#FF263C",
    seq1: "#80BEFE",
    seq2: "#459FFE",
    seq3: "#1084FE",
    seq4: "#0C64C1",
    seq5: "#084382",
    // Tone inks are text too, so on white and on their own tint they hold 4.5:1.
    success: "#006B3C",
    warning: "#8A5100",
    danger: "#B01A2A",
    accent: "#0A58AB",
    accentDeep: "#084382",
    successDeep: "#00673a",
    warningDeep: "#824e00",
    dangerDeep: "#82131f",
    div1: "#C21D2E",
    div2: "#FF8C98",
    div3: "#E8E8E8",
    div4: "#80BEFE",
    div5: "#0C64C1",
    fillStrong: "rgba(119,119,119,.11)",
    cardSurface: "#fcfcfc",
    cardShadowNear: "#0000000f",
    cardShadowFar: "#00000012",
    controlFill: "#77777717",
    controlHoverFill: "#77777726",
    buttonFill: "#070707",
    buttonHoverFill: "#2f2f2f",
    buttonInk: "#fcfcfc",
    optionFill: "#fcfcfc",
    checkedFill: "#a5a5a5",
  },
  // The same in both themes: ink on colour, the print paper and shadows.
  shared: {
    onColor: "#fcfcfc",
    onTone: "#121212",
    onDeepTone: "#fff",
    paper: "#fff",
    mask: "#000",
    tipShadow: "rgba(0,0,0,.18)",
    dotShadow: "#00000059",
  },
} as const;

/** The ink of a drawn bot's eyes, the same on every body colour and in both themes. */
export const botEyeColor = "#101014";

export const botColors = [
  "#3EC5A8",
  "#F5A03C",
  "#6A6BF5",
  "#9B5CF6",
  "#3B82F6",
  "#F2622A",
  "#D9508A",
] as const;

export function isAppearancePreference(
  value: string | null | undefined,
): value is AppearancePreference {
  return value === "system" || value === "light" || value === "dark";
}

export function normalizeAppearancePreference(
  raw: string | null | undefined,
): AppearancePreference {
  return isAppearancePreference(raw) ? raw : "system";
}

export type ResolveAppearancePreferenceOptions = {
  stored?: string | null;
  storage?: Pick<Storage, "getItem"> | null;
};

function getLocalStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

export function resolveAppearancePreference(
  options: ResolveAppearancePreferenceOptions = {},
): AppearancePreference {
  const stored =
    options.stored !== undefined
      ? options.stored
      : readStoredAppearance(options.storage ?? getLocalStorage());
  return normalizeAppearancePreference(stored);
}

export function persistAppearancePreference(
  preference: AppearancePreference,
  storage: Pick<Storage, "setItem"> | null = getLocalStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(UI_APPEARANCE_STORAGE_KEY, preference);
  } catch {
    // Ignore quota / private-mode failures; in-memory preference still applies.
  }
}

export function resolveAppearance(
  preference: AppearancePreference,
  system: ResolvedAppearance = "dark",
): ResolvedAppearance {
  if (preference === "system") return system;
  return preference;
}

export function tokensForAppearance(appearance: ResolvedAppearance): ColorTokens {
  return appearance === "light" ? lightTokens : darkTokens;
}

/** The web and Electron palette; `tokensForAppearance` is the mobile one. */
export function webTokensForAppearance(appearance: ResolvedAppearance): WebColorTokens {
  return appearance === "light" ? webLightTokens : webDarkTokens;
}

function readStoredAppearance(storage: Pick<Storage, "getItem"> | null | undefined): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(UI_APPEARANCE_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** `cardForeground` -> `--card-foreground` */
export function cssVariableName(token: keyof WebColorTokens): string {
  return `--${token.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
}

function renderBlock(selector: string, colorScheme: ResolvedAppearance, palette: WebColorTokens) {
  const lines = (Object.keys(palette) as (keyof WebColorTokens)[]).map(
    (token) => `  ${cssVariableName(token)}: ${palette[token].toLowerCase()};`,
  );
  return `${selector} {\n  color-scheme: ${colorScheme};\n${lines.join("\n")}\n  --radius: ${RADIUS};\n}`;
}

/** The CSS in `tokens.css` (web and Electron). Generated from the web palettes so both stay in sync. */
export function renderTokensCss(): string {
  return `${[
    "/* Generated by `pnpm --filter @rakazo/ui-tokens generate`. Edit src/index.ts instead. */",
    renderBlock(':root,\n[data-theme="dark"]', "dark", webDarkTokens),
    renderBlock('[data-theme="light"]', "light", webLightTokens),
  ].join("\n\n")}\n`;
}
