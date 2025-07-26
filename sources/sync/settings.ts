import * as z from 'zod';

//
// Schema
//

const SettingsSchema = z.object({
    viewInline: z.boolean().describe('Whether to view inline tool calls'),
});

//
// NOTE: Settings must be a flat object with no to minimal nesting, one field == one setting,
// you can name them with a prefix if you want to group them, but don't nest them.
// You can nest if value is a single value (like image with url and width and height)
// Settings are always merged with defaults and field by field.
// 
// This structure must be forward and backward compatible. Meaning that some versions of the app
// could be missing some fields or have a new fields. Everything must be preserved and client must 
// only touch the fields it knows about.
//

const SettingsSchemaPartial = SettingsSchema.loose().partial();

export type Settings = z.infer<typeof SettingsSchema>;

//
// Defaults
//

export const settingsDefaults: Settings = {
    viewInline: false,
};

//
// Resolving
//

export function settingsParse(settings: unknown): Settings {
    const parsed = SettingsSchemaPartial.safeParse(settings);
    if (!parsed.success) {
        return { ...settingsDefaults };
    }
    return { ...settingsDefaults, ...parsed.data };
}

//
// Applying changes
// NOTE: May be something more sophisticated here around defaults and merging, but for now this is fine.
//

export function applySettings(settings: Settings, delta: Partial<Settings>): Settings {
    return { ...settingsDefaults, ...settings, ...delta };
}