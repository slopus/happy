import type { ComponentProps } from 'react';
import type { Ionicons } from '@expo/vector-icons';

type SettingsFeatureEntryTitleKey =
    | 'settings.voiceAssistant'
    | 'generatedImages.title'
    | 'settings.agentDefaults'
    | 'settings.customInstructions'
    | 'settingsSkills.title'
    | 'settings.featuresTitle';

type SettingsFeatureEntrySubtitleKey =
    | 'settings.voiceAssistantSubtitle'
    | 'generatedImages.entrySubtitle'
    | 'settings.agentDefaultsSubtitle'
    | 'settings.customInstructionsSubtitle'
    | 'settingsSkills.entrySubtitle'
    | 'settings.featuresSubtitle';

export type SettingsFeatureEntry = {
    key: string;
    titleKey: SettingsFeatureEntryTitleKey;
    subtitleKey: SettingsFeatureEntrySubtitleKey;
    icon: ComponentProps<typeof Ionicons>['name'];
    color: string;
    route: string;
};

export function getSettingsFeatureEntries(_args: { experiments: boolean }): SettingsFeatureEntry[] {
    return [
        {
            key: 'voice',
            titleKey: 'settings.voiceAssistant',
            subtitleKey: 'settings.voiceAssistantSubtitle',
            icon: 'mic-outline',
            color: '#34C759',
            route: '/settings/voice',
        },
        {
            key: 'agent-defaults',
            titleKey: 'settings.agentDefaults',
            subtitleKey: 'settings.agentDefaultsSubtitle',
            icon: 'options-outline',
            color: '#5AC8FA',
            route: '/settings/agents',
        },
        {
            key: 'custom-instructions',
            titleKey: 'settings.customInstructions',
            subtitleKey: 'settings.customInstructionsSubtitle',
            icon: 'document-text-outline',
            color: '#FF2D55',
            route: '/settings/custom-instructions',
        },
        {
            key: 'skills',
            titleKey: 'settingsSkills.title',
            subtitleKey: 'settingsSkills.entrySubtitle',
            icon: 'cube-outline',
            color: '#34C759',
            route: '/settings/skills',
        },
        {
            key: 'features',
            titleKey: 'settings.featuresTitle',
            subtitleKey: 'settings.featuresSubtitle',
            icon: 'flask-outline',
            color: '#FF9500',
            route: '/settings/features',
        },
    ];
}
