/** The kit a page can use without importing it. Props only ever get added, never changed. */
export const PAGE_KIT_COMPONENTS = [
  "Page",
  "Section",
  "Grid",
  "Text",
  "Callout",
  "Metrics",
  "Properties",
  "Status",
  "Rows",
  "Steps",
  "Checklist",
  "Table",
  "LineChart",
  "Bars",
  "Pie",
  "Diagram",
  "Segmented",
  "TableOfContents",
  "PageHero",
  "PageMeta",
  "Footnote",
  "Divider",
  "Floating",
  "BackToTop",
  "Quote",
  "BulletList",
  "NumberedList",
  "ProsCons",
  "LinkCards",
  "Legend",
  "Equation",
  "Frac",
  "Pow",
  "Sqrt",
  "Sum",
  "Paren",
  "Columns",
  "ColumnSeries",
  "StackedBars",
  "Scatter",
  "Heatmap",
  "CalendarHeatmap",
  "Venn",
  "Matrix2x2",
  "SourceStamp",
  "Button",
  "ReplyButton",
  "CopyButton",
  "LinkButton",
  "TextLink",
  "Select",
  "Input",
  "Toggle",
  "Checkbox",
  "Image",
  "Video",
  "Audio",
  "Gallery",
  "PhotoStrip",
  "CardGrid",
  "CardCarousel",
  "ProductCard",
  "ProductRows",
  "RatingSummary",
  "WatchCard",
  "Avatar",
  "AvatarStack",
  "MonthView",
  "WeekView",
  "DayView",
] as const;

export type PageKitComponentName = (typeof PAGE_KIT_COMPONENTS)[number];

/** React hooks a page may call by name, as models write them out of habit. */
export const PAGE_HOOKS = [
  "useState",
  "useMemo",
  "useEffect",
  "useRef",
  "useCallback",
  "useReducer",
] as const;

/** Functions from the kit that are not components: the theme, sources and diagram layout. */
export const PAGE_HELPERS = ["useTheme", "useSource", "computeDAGLayout", "copyText"] as const;

export type PageHelperName = (typeof PAGE_HELPERS)[number];

/** Everything else a page's code is given: React, its hooks, Fragment and the kit. */
export const PAGE_GLOBALS = [
  "React",
  "Fragment",
  ...PAGE_HOOKS,
  ...PAGE_HELPERS,
  ...PAGE_KIT_COMPONENTS,
] as const;

/** Modules a page may import from out of habit; both resolve to what is already in scope. */
export const PAGE_KIT_MODULE = "rakazo/page";
export const PAGE_MODULES: ReadonlySet<string> = new Set(["react", PAGE_KIT_MODULE]);
