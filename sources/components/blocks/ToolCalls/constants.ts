// Font size constants for tool compact views
// These should be used consistently across all tool components

export const TOOL_COMPACT_VIEW_STYLES = {
  // Font sizes - matching MarkdownView.tsx
  CONTENT_SIZE: 'text-base',   // 16px - for main content text
  METADATA_SIZE: 'text-sm',    // 12px - for result counts, status text, etc.
  
  // Icon sizes (numeric values for Ionicons)
  ICON_SIZE: 16, // Increased to match text size
  
  // Colors
  ICON_COLOR: '#a1a1a1',
  TOOL_NAME_COLOR: 'text-neutral-500',
  CONTENT_COLOR: 'text-neutral-500',
  METADATA_COLOR: 'text-neutral-500',
  
  // Common class combinations for consistent styling
  CONTENT_CLASSES: 'text-base leading-6 font-normal flex-1 text-neutral-500 flex-1',
  METADATA_CLASSES: 'text-sm text-neutral-500 font-bold px-1 basis-full',
} as const;

// Container styles - padding should come from SingleLineToolSummaryBlock
// Individual tool components should NOT add their own py-* classes
export const TOOL_CONTAINER_STYLES = {
  // The base container for tool compact views
  // Note: py-* padding comes from SingleLineToolSummaryBlock, not here
  BASE_CONTAINER: 'flex-row gap-1 items-center flex-wrap',
} as const; 