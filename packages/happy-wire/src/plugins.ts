import * as z from 'zod';

const PluginIdSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(100);
const PluginVersionSchema = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/).max(50);
const PluginFieldKeySchema = z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/).max(100);
const PluginContributionIdSchema = z.string().regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/).max(160);

export const PluginLocalizedTextSchema = z.object({
  default: z.string().min(1).max(2_000),
  translations: z.record(z.string().min(2).max(20), z.string().min(1).max(2_000)).optional(),
}).strict();

export const PluginConfigurationFieldSchema = z.object({
  key: PluginFieldKeySchema,
  type: z.enum(['text', 'url', 'secret']),
  required: z.boolean(),
  label: PluginLocalizedTextSchema,
  placeholder: PluginLocalizedTextSchema.optional(),
}).strict();

export const PluginPermissionSchema = z.enum([
  'paws.ai.provider.invoke',
  'paws.secrets.use',
  'paws.conversations.images.read',
  'paws.storage.images.write',
]);

export const PluginPermissionListSchema = z.array(PluginPermissionSchema).max(20).superRefine((permissions, context) => {
  if (new Set(permissions).size !== permissions.length) {
    context.addIssue({
      code: 'custom',
      message: 'Plugin permissions must be unique',
    });
  }
});

export const PluginViewSurfaceSchema = z.enum(['page', 'left-sidebar', 'right-panel', 'modal']);

export const PluginViewContributionSchema = z.object({
  id: PluginContributionIdSchema,
  surface: PluginViewSurfaceSchema,
  title: PluginLocalizedTextSchema,
  icon: z.string().regex(/^[A-Za-z0-9-]+$/).max(100).optional(),
}).strict();

export const PluginManifestSchema = z.object({
  schemaVersion: z.literal(2),
  hostApiVersion: z.literal(1),
  id: PluginIdSchema,
  version: PluginVersionSchema,
  title: PluginLocalizedTextSchema,
  description: PluginLocalizedTextSchema,
  icon: z.string().regex(/^[A-Za-z0-9-]+$/).max(100),
  featured: z.boolean(),
  installedAction: z.enum(['configure', 'open']),
  permissions: PluginPermissionListSchema,
  entrypoint: z.discriminatedUnion('type', [
    z.object({
      type: z.literal('view'),
      viewId: PluginContributionIdSchema,
    }).strict(),
    z.object({
      type: z.literal('configuration'),
      viewId: PluginContributionIdSchema,
    }).strict(),
  ]),
  contributes: z.object({
    views: z.array(PluginViewContributionSchema).max(50),
  }).strict(),
  configuration: z.object({
    notice: PluginLocalizedTextSchema.optional(),
    fields: z.array(PluginConfigurationFieldSchema).max(20),
  }).strict(),
}).strict().superRefine((manifest, context) => {
  const viewIds = new Set<string>();
  for (const view of manifest.contributes.views) {
    if (!view.id.startsWith(`${manifest.id}.`)) {
      context.addIssue({
        code: 'custom',
        message: `Plugin view contribution must be namespaced by ${manifest.id}`,
        path: ['contributes', 'views'],
      });
    }
    if (viewIds.has(view.id)) {
      context.addIssue({
        code: 'custom',
        message: `Duplicate plugin view contribution: ${view.id}`,
        path: ['contributes', 'views'],
      });
    }
    viewIds.add(view.id);
  }
  const entrypoint = manifest.contributes.views.find((view) => view.id === manifest.entrypoint.viewId);
  const expectedEntrypointSurface = manifest.entrypoint.type === 'view' ? 'page' : 'modal';
  if (!entrypoint || entrypoint.surface !== expectedEntrypointSurface) {
    context.addIssue({
      code: 'custom',
      message: `Plugin entrypoint must reference a contributed ${expectedEntrypointSurface} view`,
      path: ['entrypoint', 'viewId'],
    });
  }
});

export const PluginInstallationStatusSchema = z.discriminatedUnion('installed', [
  z.object({ installed: z.literal(false) }).strict(),
  z.object({
    installed: z.literal(true),
    version: PluginVersionSchema,
    grantedPermissions: PluginPermissionListSchema,
    configuration: z.record(PluginFieldKeySchema, z.string().max(2_000)),
    secretHints: z.record(PluginFieldKeySchema, z.string().max(100)),
  }).strict(),
]);

export const PluginCatalogItemSchema = z.object({
  manifest: PluginManifestSchema,
  status: PluginInstallationStatusSchema,
}).strict();

export const PluginCatalogResponseSchema = z.object({
  plugins: z.array(PluginCatalogItemSchema),
}).strict();

export const PluginInstallRequestSchema = z.object({
  version: PluginVersionSchema,
  grantedPermissions: PluginPermissionListSchema,
  configuration: z.record(PluginFieldKeySchema, z.string().max(4_000)),
}).strict();

export const PluginConnectionTestFailureCodeSchema = z.enum([
  'invalid_configuration',
  'authentication_failed',
  'model_not_found',
  'rate_limited',
  'timed_out',
  'provider_unreachable',
  'provider_error',
]);

export const PluginConnectionTestResultSchema = z.discriminatedUnion('success', [
  z.object({
    success: z.literal(true),
    latencyMs: z.number().int().nonnegative().max(120_000),
  }).strict(),
  z.object({
    success: z.literal(false),
    code: PluginConnectionTestFailureCodeSchema,
  }).strict(),
]);

export type PluginLocalizedText = z.infer<typeof PluginLocalizedTextSchema>;
export type PluginConfigurationField = z.infer<typeof PluginConfigurationFieldSchema>;
export type PluginPermission = z.infer<typeof PluginPermissionSchema>;
export type PluginViewSurface = z.infer<typeof PluginViewSurfaceSchema>;
export type PluginViewContribution = z.infer<typeof PluginViewContributionSchema>;
export type PluginManifest = z.infer<typeof PluginManifestSchema>;
export type PluginInstallationStatus = z.infer<typeof PluginInstallationStatusSchema>;
export type PluginCatalogItem = z.infer<typeof PluginCatalogItemSchema>;
export type PluginCatalogResponse = z.infer<typeof PluginCatalogResponseSchema>;
export type PluginInstallRequest = z.infer<typeof PluginInstallRequestSchema>;
export type PluginConnectionTestFailureCode = z.infer<typeof PluginConnectionTestFailureCodeSchema>;
export type PluginConnectionTestResult = z.infer<typeof PluginConnectionTestResultSchema>;
