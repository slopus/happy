import { describe, expect, it } from 'vitest';

import {
  PluginCatalogResponseSchema,
  PluginInstallRequestSchema,
  PluginManifestSchema,
} from './plugins';

const manifest = {
  schemaVersion: 2 as const,
  hostApiVersion: 1 as const,
  id: 'relationship-advisor',
  version: '1.0.0',
  title: { default: 'Relationship Advisor', translations: { 'zh-Hans': '狗头军师' } },
  description: { default: 'Fast cloud conversations' },
  icon: 'chatbubbles-outline',
  featured: true,
  installedAction: 'configure' as const,
  permissions: [
    'paws.ai.provider.invoke' as const,
    'paws.secrets.use' as const,
    'paws.conversations.images.read' as const,
    'paws.storage.images.write' as const,
  ],
  entrypoint: { type: 'view' as const, viewId: 'relationship-advisor.chat' },
  contributes: {
    views: [
      {
        id: 'relationship-advisor.chat',
        surface: 'page' as const,
        title: { default: 'Relationship Advisor' },
        icon: 'chatbubbles-outline',
      },
      {
        id: 'relationship-advisor.history',
        surface: 'left-sidebar' as const,
        title: { default: 'Advisor history' },
      },
    ],
  },
  configuration: {
    notice: { default: 'Secrets are encrypted on the Paws server.' },
    fields: [
      {
        key: 'apiKey',
        type: 'secret' as const,
        required: true,
        label: { default: 'API Key' },
        placeholder: { default: 'sk-...' },
      },
    ],
  },
};

describe('plugin wire contract', () => {
  it('accepts a server-driven manifest with localized metadata and declarative fields', () => {
    expect(PluginManifestSchema.parse(manifest)).toEqual(manifest);
  });

  it('rejects executable entrypoints and invalid plugin versions', () => {
    expect(() => PluginManifestSchema.parse({
      ...manifest,
      version: 'latest',
      entrypoint: { type: 'javascript', source: 'alert(1)' },
    })).toThrow();
  });

  it('accepts a configuration-only plugin with a modal entrypoint and no page', () => {
    const configurationOnly = {
      ...manifest,
      id: 'configuration-only',
      installedAction: 'configure' as const,
      entrypoint: {
        type: 'configuration' as const,
        viewId: 'configuration-only.settings',
      },
      contributes: {
        views: [{
          id: 'configuration-only.settings',
          surface: 'modal' as const,
          title: { default: 'Settings' },
        }],
      },
    };

    expect(PluginManifestSchema.parse(configurationOnly)).toEqual(configurationOnly);
  });

  it('rejects undeclared capabilities, unknown surfaces, and entrypoints that are not contributed pages', () => {
    expect(() => PluginManifestSchema.parse({
      ...manifest,
      permissions: ['paws.shell.execute'],
    })).toThrow();
    expect(() => PluginManifestSchema.parse({
      ...manifest,
      contributes: {
        views: [{
          id: 'relationship-advisor.chat',
          surface: 'floating-window',
          title: { default: 'Relationship Advisor' },
        }],
      },
    })).toThrow();
    expect(() => PluginManifestSchema.parse({
      ...manifest,
      entrypoint: { type: 'view', viewId: 'relationship-advisor.missing' },
    })).toThrow();
    expect(() => PluginManifestSchema.parse({
      ...manifest,
      id: 'renamed-plugin',
    })).toThrow();
  });

  it('models installed versions without returning secret configuration values', () => {
    const catalog = PluginCatalogResponseSchema.parse({
      plugins: [{
        manifest,
        status: {
          installed: true,
          version: '1.0.0',
          configuration: {},
          secretHints: { apiKey: '1234' },
        },
      }],
    });

    expect(catalog.plugins[0].status).toEqual({
      installed: true,
      version: '1.0.0',
      configuration: {},
      secretHints: { apiKey: '1234' },
    });
  });

  it('requires clients to pin the manifest version when installing', () => {
    expect(PluginInstallRequestSchema.parse({
      version: '1.0.0',
      configuration: { apiKey: 'secret' },
    })).toEqual({
      version: '1.0.0',
      configuration: { apiKey: 'secret' },
    });
    expect(() => PluginInstallRequestSchema.parse({ version: 'latest', configuration: {} })).toThrow();
  });
});
