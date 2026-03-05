import { z } from 'zod';

// Viewport preset for device simulation
export const ViewportPresetSchema = z.object({
  id: z.string(),
  label: z.string(),
  width: z.number().nullable(), // null = auto (responsive)
  height: z.number().nullable(),
  icon: z.enum(['resize-outline', 'phone-portrait-outline', 'tablet-portrait-outline', 'laptop-outline']),
});

export type ViewportPreset = z.infer<typeof ViewportPresetSchema>;

export const VIEWPORT_PRESETS: ViewportPreset[] = [
  { id: 'auto', label: 'Auto', width: null, height: null, icon: 'resize-outline' },
  { id: 'iphone-se', label: 'SE', width: 375, height: 667, icon: 'phone-portrait-outline' },
  { id: 'iphone-16', label: '16', width: 390, height: 844, icon: 'phone-portrait-outline' },
  { id: 'iphone-17-pro', label: '17 Pro', width: 402, height: 874, icon: 'phone-portrait-outline' },
  { id: 'iphone-17-pm', label: '17 PM', width: 440, height: 956, icon: 'phone-portrait-outline' },
  { id: 'ipad-mini', label: 'iPad mini', width: 744, height: 1133, icon: 'tablet-portrait-outline' },
  { id: 'ipad-air', label: 'iPad Air', width: 820, height: 1180, icon: 'tablet-portrait-outline' },
  { id: 'ipad-pro', label: 'iPad Pro', width: 1032, height: 1376, icon: 'tablet-portrait-outline' },
  { id: 'macbook-air', label: 'MacBook Air', width: 1280, height: 832, icon: 'laptop-outline' },
  { id: 'macbook-pro', label: 'MacBook Pro', width: 1728, height: 1117, icon: 'laptop-outline' },
];

// Element selected by user in the Preview Panel
export const SelectedElementSchema = z.object({
  selector: z.string(),
  xpath: z.string().optional(),
  tag: z.string(),
  classes: z.array(z.string()),
  id: z.string().nullable(),
  text: z.string(),
  outerHTML: z.string(),
  parentContext: z.string(),
  boundingBox: z.object({
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
  }),
  screenshot: z.string().optional(),
  sourceFile: z.string().optional(),
  sourceLine: z.number().optional(),
});

export type SelectedElement = z.infer<typeof SelectedElementSchema>;

// Preview panel state per session
export const PreviewStateSchema = z.object({
  url: z.string().nullable(),
  proxyUrl: z.string().nullable(),
  inspectMode: z.boolean(),
  selectedElement: SelectedElementSchema.nullable(),
  selectedElements: z.array(SelectedElementSchema),
  detectedServers: z.array(
    z.object({
      port: z.number(),
      title: z.string().optional(),
    }),
  ),
  hasHMR: z.boolean(),
  stack: z.string().optional(),
  isVisible: z.boolean(),
  viewportPreset: z.string(),
  viewportRotated: z.boolean(),
  deviceBarVisible: z.boolean(),
});

export type PreviewState = z.infer<typeof PreviewStateSchema>;

// Default state factory
export function createDefaultPreviewState(): PreviewState {
  return {
    url: null,
    proxyUrl: null,
    inspectMode: false,
    selectedElement: null,
    selectedElements: [],
    detectedServers: [],
    hasHMR: false,
    isVisible: false,
    viewportPreset: 'auto',
    viewportRotated: false,
    deviceBarVisible: false,
  };
}
