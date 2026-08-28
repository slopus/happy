import type { ComponentProps } from 'react';
import type { Ionicons } from '@expo/vector-icons';

type SettingsFeatureEntryTitleKey =
    | 'settings.voiceAssistant'
    | 'settings.askApi'
    | 'settings.publicImageGateway'
    | 'agents.imageStyleAgent'
    | 'generatedImages.title'
    | 'agents.title'
    | 'settings.agentDefaults'
    | 'settings.customInstructions'
    | 'settingsSkills.title'
    | 'settings.featuresTitle'
    | 'settings.usage';

type SettingsFeatureEntrySubtitleKey =
    | 'settings.voiceAssistantSubtitle'
    | 'settings.askApiSubtitle'
    | 'settings.publicImageGatewaySubtitle'
    | 'agents.imageStyleAgentEntrySubtitle'
    | 'generatedImages.entrySubtitle'
    | 'agents.entrySubtitle'
    | 'settings.agentDefaultsSubtitle'
    | 'settings.customInstructionsSubtitle'
    | 'settingsSkills.entrySubtitle'
    | 'settings.featuresSubtitle'
    | 'settings.usageSubtitle';

export type SettingsFeatureEntry = {
    key: string;
    titleKey: SettingsFeatureEntryTitleKey;
    subtitleKey: SettingsFeatureEntrySubtitleKey;
    icon: ComponentProps<typeof Ionicons>['name'];
    color: string;
    route: string;
};

export function getSettingsFeatureEntries(args: { experiments: boolean }): SettingsFeatureEntry[] {
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
            key: 'ask-api',
            titleKey: 'settings.askApi',
            subtitleKey: 'settings.askApiSubtitle',
            icon: 'chatbubble-ellipses-outline',
            color: '#5856D6',
            route: '/settings/ask',
        },
        {
            key: 'public-image-gateway',
            titleKey: 'settings.publicImageGateway',
            subtitleKey: 'settings.publicImageGatewaySubtitle',
            icon: 'earth-outline',
            color: '#1F6F5B',
            route: '/settings/public-image-gateway',
        },
        {
            key: 'image-style-agent',
            titleKey: 'agents.imageStyleAgent',
            subtitleKey: 'agents.imageStyleAgentEntrySubtitle',
            icon: 'images-outline',
            color: '#AF52DE',
            route: '/settings/my-agent-edit?kind=image-styles',
        },
        {
            key: 'my-agents',
            titleKey: 'agents.title',
            subtitleKey: 'agents.entrySubtitle',
            icon: 'people-outline',
            color: '#FF9500',
            route: '/settings/my-agents',
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
        ...(args.experiments ? [{
            key: 'usage',
            titleKey: 'settings.usage' as const,
            subtitleKey: 'settings.usageSubtitle' as const,
            icon: 'analytics-outline' as const,
            color: 'accent',
            route: '/settings/usage',
        }] : []),
    ];
}
