/**
 * Profile Synchronization Service
 *
 * Handles bidirectional synchronization of profiles between GUI and CLI storage.
 * Ensures consistent profile data across both systems with proper conflict resolution.
 */

import { AIBackendProfile, validateProfileForAgent, getProfileEnvironmentVariables } from './settings';
import { sync } from './sync';
import { apiSocket } from './apiSocket';
import { Modal } from '@/modal';

// Profile sync status types
export type SyncStatus = 'idle' | 'syncing' | 'success' | 'error';
export type SyncDirection = 'gui-to-cli' | 'cli-to-gui' | 'bidirectional';

// Profile sync conflict resolution strategies
export type ConflictResolution = 'gui-wins' | 'cli-wins' | 'most-recent' | 'merge';

// Profile sync event data
export interface ProfileSyncEvent {
    direction: SyncDirection;
    status: SyncStatus;
    profilesSynced?: number;
    error?: string;
    timestamp: number;
}

// Profile sync configuration
export interface ProfileSyncConfig {
    autoSync: boolean;
    conflictResolution: ConflictResolution;
    syncOnProfileChange: boolean;
    syncOnAppStart: boolean;
}

// Default sync configuration
const DEFAULT_SYNC_CONFIG: ProfileSyncConfig = {
    autoSync: true,
    conflictResolution: 'most-recent',
    syncOnProfileChange: true,
    syncOnAppStart: true,
};

class ProfileSyncService {
    private static instance: ProfileSyncService;
    private syncStatus: SyncStatus = 'idle';
    private lastSyncTime: number = 0;
    private config: ProfileSyncConfig = DEFAULT_SYNC_CONFIG;
    private eventListeners: Array<(event: ProfileSyncEvent) => void> = [];

    private constructor() {
        // Private constructor for singleton
    }

    public static getInstance(): ProfileSyncService {
        if (!ProfileSyncService.instance) {
            ProfileSyncService.instance = new ProfileSyncService();
        }
        return ProfileSyncService.instance;
    }

    /**
     * Add event listener for sync events
     */
    public addEventListener(listener: (event: ProfileSyncEvent) => void): void {
        this.eventListeners.push(listener);
    }

    /**
     * Remove event listener
     */
    public removeEventListener(listener: (event: ProfileSyncEvent) => void): void {
        const index = this.eventListeners.indexOf(listener);
        if (index > -1) {
            this.eventListeners.splice(index, 1);
        }
    }

    /**
     * Emit sync event to all listeners
     */
    private emitEvent(event: ProfileSyncEvent): void {
        this.eventListeners.forEach(listener => {
            try {
                listener(event);
            } catch (error) {
                console.error('[ProfileSync] Event listener error:', error);
            }
        });
    }

    /**
     * Update sync configuration
     */
    public updateConfig(config: Partial<ProfileSyncConfig>): void {
        this.config = { ...this.config, ...config };
    }

    /**
     * Get current sync configuration
     */
    public getConfig(): ProfileSyncConfig {
        return { ...this.config };
    }

    /**
     * Get current sync status
     */
    public getSyncStatus(): SyncStatus {
        return this.syncStatus;
    }

    /**
     * Get last sync time
     */
    public getLastSyncTime(): number {
        return this.lastSyncTime;
    }

    /**
     * Sync profiles from GUI to CLI
     */
    public async syncGuiToCli(profiles: AIBackendProfile[]): Promise<void> {
        if (this.syncStatus === 'syncing') {
            throw new Error('Sync already in progress');
        }

        this.syncStatus = 'syncing';
        this.emitEvent({
            direction: 'gui-to-cli',
            status: 'syncing',
            timestamp: Date.now(),
        });

        try {
            // Direct file-based sync to CLI settings
            try {
                const fs = await import('node:fs/promises');
                const path = await import('node:path');
                const os = await import('node:os');

                const settingsPath = path.join(os.homedir(), '.happy', 'settings.json');

                let cliSettings: any = {};
                try {
                    const content = await fs.readFile(settingsPath, 'utf8');
                    cliSettings = JSON.parse(content);
                } catch (error) {
                    // Settings file doesn't exist or is corrupted, start with defaults
                    cliSettings = {
                        onboardingCompleted: false,
                        profiles: [],
                        localEnvironmentVariables: {}
                    };
                }

                // Update profiles in CLI settings
                const updatedSettings = {
                    ...cliSettings,
                    profiles: profiles,
                    // Preserve active profile ID if it still exists
                    activeProfileId: cliSettings.activeProfileId &&
                        profiles.find(p => p.id === cliSettings.activeProfileId)
                        ? cliSettings.activeProfileId
                        : undefined
                };

                // Ensure directory exists
                const happyDir = path.dirname(settingsPath);
                await fs.mkdir(happyDir, { recursive: true });

                // Write updated settings
                await fs.writeFile(settingsPath, JSON.stringify(updatedSettings, null, 2));

                console.log(`[ProfileSync] Synced ${profiles.length} profiles to CLI settings`);
            } catch (error) {
                console.warn('[ProfileSync] CLI sync failed - CLI may not be installed:', error);
                // Don't fail the operation - GUI profiles are still valid
            }

            this.lastSyncTime = Date.now();
            this.syncStatus = 'success';

            this.emitEvent({
                direction: 'gui-to-cli',
                status: 'success',
                profilesSynced: profiles.length,
                timestamp: Date.now(),
            });
        } catch (error) {
            this.syncStatus = 'error';
            const errorMessage = error instanceof Error ? error.message : 'Unknown sync error';

            this.emitEvent({
                direction: 'gui-to-cli',
                status: 'error',
                error: errorMessage,
                timestamp: Date.now(),
            });

            throw error;
        }
    }

    /**
     * Sync profiles from CLI to GUI
     */
    public async syncCliToGui(): Promise<AIBackendProfile[]> {
        if (this.syncStatus === 'syncing') {
            throw new Error('Sync already in progress');
        }

        this.syncStatus = 'syncing';
        this.emitEvent({
            direction: 'cli-to-gui',
            status: 'syncing',
            timestamp: Date.now(),
        });

        try {
            // Read profiles directly from CLI settings file
            let cliProfiles: AIBackendProfile[] = [];
            try {
                const fs = await import('node:fs/promises');
                const path = await import('node:path');
                const os = await import('node:os');

                const settingsPath = path.join(os.homedir(), '.happy', 'settings.json');

                const content = await fs.readFile(settingsPath, 'utf8');
                const cliSettings = JSON.parse(content);

                cliProfiles = cliSettings.profiles || [];
                console.log(`[ProfileSync] Read ${cliProfiles.length} profiles from CLI settings`);
            } catch (error) {
                console.warn('[ProfileSync] CLI settings read failed - CLI may not be installed:', error);
                // Return empty array if CLI settings not accessible
                cliProfiles = [];
            }

            this.lastSyncTime = Date.now();
            this.syncStatus = 'success';

            this.emitEvent({
                direction: 'cli-to-gui',
                status: 'success',
                profilesSynced: cliProfiles.length,
                timestamp: Date.now(),
            });

            return cliProfiles;
        } catch (error) {
            this.syncStatus = 'error';
            const errorMessage = error instanceof Error ? error.message : 'Unknown sync error';

            this.emitEvent({
                direction: 'cli-to-gui',
                status: 'error',
                error: errorMessage,
                timestamp: Date.now(),
            });

            throw error;
        }
    }

    /**
     * Perform bidirectional sync with conflict resolution
     */
    public async bidirectionalSync(guiProfiles: AIBackendProfile[]): Promise<AIBackendProfile[]> {
        if (this.syncStatus === 'syncing') {
            throw new Error('Sync already in progress');
        }

        this.syncStatus = 'syncing';
        this.emitEvent({
            direction: 'bidirectional',
            status: 'syncing',
            timestamp: Date.now(),
        });

        try {
            // Get CLI profiles
            const cliProfiles = await this.syncCliToGui();

            // Resolve conflicts based on configuration
            const resolvedProfiles = await this.resolveConflicts(guiProfiles, cliProfiles);

            // Update CLI with resolved profiles
            await this.syncGuiToCli(resolvedProfiles);

            this.lastSyncTime = Date.now();
            this.syncStatus = 'success';

            this.emitEvent({
                direction: 'bidirectional',
                status: 'success',
                profilesSynced: resolvedProfiles.length,
                timestamp: Date.now(),
            });

            return resolvedProfiles;
        } catch (error) {
            this.syncStatus = 'error';
            const errorMessage = error instanceof Error ? error.message : 'Unknown sync error';

            this.emitEvent({
                direction: 'bidirectional',
                status: 'error',
                error: errorMessage,
                timestamp: Date.now(),
            });

            throw error;
        }
    }

    /**
     * Resolve conflicts between GUI and CLI profiles
     */
    private async resolveConflicts(
        guiProfiles: AIBackendProfile[],
        cliProfiles: AIBackendProfile[]
    ): Promise<AIBackendProfile[]> {
        const { conflictResolution } = this.config;
        const resolvedProfiles: AIBackendProfile[] = [];
        const processedIds = new Set<string>();

        // Process profiles that exist in both GUI and CLI
        for (const guiProfile of guiProfiles) {
            const cliProfile = cliProfiles.find(p => p.id === guiProfile.id);

            if (cliProfile) {
                let resolvedProfile: AIBackendProfile;

                switch (conflictResolution) {
                    case 'gui-wins':
                        resolvedProfile = { ...guiProfile, updatedAt: Date.now() };
                        break;
                    case 'cli-wins':
                        resolvedProfile = { ...cliProfile, updatedAt: Date.now() };
                        break;
                    case 'most-recent':
                        resolvedProfile = guiProfile.updatedAt! >= cliProfile.updatedAt!
                            ? { ...guiProfile }
                            : { ...cliProfile };
                        break;
                    case 'merge':
                        resolvedProfile = await this.mergeProfiles(guiProfile, cliProfile);
                        break;
                    default:
                        resolvedProfile = { ...guiProfile };
                }

                resolvedProfiles.push(resolvedProfile);
                processedIds.add(guiProfile.id);
            } else {
                // Profile exists only in GUI
                resolvedProfiles.push({ ...guiProfile, updatedAt: Date.now() });
                processedIds.add(guiProfile.id);
            }
        }

        // Add profiles that exist only in CLI
        for (const cliProfile of cliProfiles) {
            if (!processedIds.has(cliProfile.id)) {
                resolvedProfiles.push({ ...cliProfile, updatedAt: Date.now() });
            }
        }

        return resolvedProfiles;
    }

    /**
     * Merge two profiles, preferring non-null values from both
     */
    private async mergeProfiles(
        guiProfile: AIBackendProfile,
        cliProfile: AIBackendProfile
    ): Promise<AIBackendProfile> {
        const merged: AIBackendProfile = {
            id: guiProfile.id,
            name: guiProfile.name || cliProfile.name,
            description: guiProfile.description || cliProfile.description,
            anthropicConfig: { ...cliProfile.anthropicConfig, ...guiProfile.anthropicConfig },
            openaiConfig: { ...cliProfile.openaiConfig, ...guiProfile.openaiConfig },
            azureOpenAIConfig: { ...cliProfile.azureOpenAIConfig, ...guiProfile.azureOpenAIConfig },
            togetherAIConfig: { ...cliProfile.togetherAIConfig, ...guiProfile.togetherAIConfig },
            tmuxConfig: { ...cliProfile.tmuxConfig, ...guiProfile.tmuxConfig },
            environmentVariables: this.mergeEnvironmentVariables(
                cliProfile.environmentVariables || [],
                guiProfile.environmentVariables || []
            ),
            compatibility: { ...cliProfile.compatibility, ...guiProfile.compatibility },
            isBuiltIn: guiProfile.isBuiltIn || cliProfile.isBuiltIn,
            createdAt: Math.min(guiProfile.createdAt || 0, cliProfile.createdAt || 0),
            updatedAt: Math.max(guiProfile.updatedAt || 0, cliProfile.updatedAt || 0),
            version: guiProfile.version || cliProfile.version || '1.0.0',
        };

        return merged;
    }

    /**
     * Merge environment variables from two profiles
     */
    private mergeEnvironmentVariables(
        cliVars: Array<{ name: string; value: string }>,
        guiVars: Array<{ name: string; value: string }>
    ): Array<{ name: string; value: string }> {
        const mergedVars = new Map<string, string>();

        // Add CLI variables first
        cliVars.forEach(v => mergedVars.set(v.name, v.value));

        // Override with GUI variables
        guiVars.forEach(v => mergedVars.set(v.name, v.value));

        return Array.from(mergedVars.entries()).map(([name, value]) => ({ name, value }));
    }

    /**
     * Set active profile in CLI
     */
    public async setActiveProfile(profileId: string): Promise<void> {
        try {
            // Store in GUI settings
            sync.applySettings({ lastUsedProfile: profileId });

            // Also set in CLI settings if available
            try {
                const fs = await import('node:fs/promises');
                const path = await import('node:path');
                const os = await import('node:os');

                const settingsPath = path.join(os.homedir(), '.happy', 'settings.json');

                let cliSettings: any = {};
                try {
                    const content = await fs.readFile(settingsPath, 'utf8');
                    cliSettings = JSON.parse(content);
                } catch (error) {
                    // Settings file doesn't exist, create minimal structure
                    cliSettings = {
                        onboardingCompleted: false,
                        profiles: [],
                        localEnvironmentVariables: {}
                    };
                }

                // Update active profile in CLI settings
                const updatedSettings = {
                    ...cliSettings,
                    activeProfileId: profileId
                };

                // Ensure directory exists
                const happyDir = path.dirname(settingsPath);
                await fs.mkdir(happyDir, { recursive: true });

                // Write updated settings
                await fs.writeFile(settingsPath, JSON.stringify(updatedSettings, null, 2));

                console.log(`[ProfileSync] Set active profile ${profileId} in CLI settings`);
            } catch (error) {
                console.warn('[ProfileSync] Failed to set active profile in CLI settings:', error);
                // Don't fail the operation - GUI setting is still applied
            }
        } catch (error) {
            console.error('[ProfileSync] Failed to set active profile:', error);
            throw error;
        }
    }

    /**
     * Get active profile from CLI
     */
    public async getActiveProfile(): Promise<AIBackendProfile | null> {
        try {
            try {
                const fs = await import('node:fs/promises');
                const path = await import('node:path');
                const os = await import('node:os');

                const settingsPath = path.join(os.homedir(), '.happy', 'settings.json');

                const content = await fs.readFile(settingsPath, 'utf8');
                const cliSettings = JSON.parse(content);

                if (!cliSettings.activeProfileId) {
                    return null;
                }

                const activeProfile = cliSettings.profiles?.find((p: AIBackendProfile) => p.id === cliSettings.activeProfileId);
                if (activeProfile) {
                    console.log(`[ProfileSync] Retrieved active profile ${activeProfile.name} from CLI settings`);
                    return activeProfile;
                }

                return null;
            } catch (error) {
                console.warn('[ProfileSync] Failed to get active profile from CLI settings:', error);
                return null;
            }
        } catch (error) {
            console.error('[ProfileSync] Failed to get active profile:', error);
            return null;
        }
    }

    /**
     * Auto-sync if enabled and conditions are met
     */
    public async autoSyncIfNeeded(guiProfiles: AIBackendProfile[]): Promise<void> {
        if (!this.config.autoSync) {
            return;
        }

        const timeSinceLastSync = Date.now() - this.lastSyncTime;
        const AUTO_SYNC_INTERVAL = 5 * 60 * 1000; // 5 minutes

        if (timeSinceLastSync > AUTO_SYNC_INTERVAL) {
            try {
                await this.bidirectionalSync(guiProfiles);
            } catch (error) {
                console.error('[ProfileSync] Auto-sync failed:', error);
                // Don't throw for auto-sync failures
            }
        }
    }
}

// Export singleton instance
export const profileSyncService = ProfileSyncService.getInstance();

// Export convenience functions
export const syncGuiToCli = (profiles: AIBackendProfile[]) => profileSyncService.syncGuiToCli(profiles);
export const syncCliToGui = () => profileSyncService.syncCliToGui();
export const bidirectionalSync = (guiProfiles: AIBackendProfile[]) => profileSyncService.bidirectionalSync(guiProfiles);
export const setActiveProfile = (profileId: string) => profileSyncService.setActiveProfile(profileId);
export const getActiveProfile = () => profileSyncService.getActiveProfile();