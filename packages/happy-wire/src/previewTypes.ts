import { z } from 'zod';

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
  detectedServers: z.array(
    z.object({
      port: z.number(),
      title: z.string().optional(),
    }),
  ),
  hasHMR: z.boolean(),
  stack: z.string().optional(),
  isVisible: z.boolean(),
});

export type PreviewState = z.infer<typeof PreviewStateSchema>;

// Default state factory
export function createDefaultPreviewState(): PreviewState {
  return {
    url: null,
    proxyUrl: null,
    inspectMode: false,
    selectedElement: null,
    detectedServers: [],
    hasHMR: false,
    isVisible: false,
  };
}
