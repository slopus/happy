import type { PluginCatalogItem } from '@slopus/happy-wire';

export function isCurrentPluginInstallation(plugin: PluginCatalogItem): boolean {
    if (!plugin.status.installed || plugin.status.version !== plugin.manifest.version) return false;
    const grantedPermissions = plugin.status.grantedPermissions;
    const declaredPermissions = plugin.manifest.permissions;
    return grantedPermissions.length === declaredPermissions.length
        && declaredPermissions.every((permission) => grantedPermissions.includes(permission));
}
