import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { Modal } from '@/modal';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import {
    getEffortLevelsForModel,
    getHardcodedModelModes,
    getHardcodedPermissionModes,
    type ModeOption,
} from '@/components/modelModeOptions';
import { useSettingMutable } from '@/sync/storage';
import {
    agentKeys,
    getCodeAgentDefaults,
    getAgentDefaultOverrideValue,
    hasAgentDefaultOverride,
    resolveAgentDefaultConfig,
    setAgentDefaultOverride,
    type AgentDefaultField,
    type AgentKey,
} from '@/sync/agentDefaults';
import { isValidTmuxSessionName } from '@/sync/spawnEnvironment';
import { t } from '@/text';

type ExpandedField = {
    agent: AgentKey;
    field: AgentDefaultField;
} | null;

type FieldConfig = {
    field: AgentDefaultField;
    title: string;
    icon: keyof typeof Ionicons.glyphMap;
    options: ModeOption[];
    codeDefaultKey: string | null;
};

const agentLabels: Record<AgentKey, string> = {
    claude: 'Claude Code',
    codex: 'Codex',
    gemini: 'Gemini',
    openclaw: 'OpenClaw',
};

function optionName(options: ModeOption[], key: string | null | undefined): string {
    if (!key) return 'none';
    return options.find((option) => option.key === key)?.name ?? key;
}

export default function AgentDefaultsSettingsScreen() {
    const { theme } = useUnistyles();
    const [agentDefaultOverrides, setAgentDefaultOverrides] = useSettingMutable('agentDefaultOverrides');
    const [claudeTmuxSessionName, setClaudeTmuxSessionName] = useSettingMutable('claudeTmuxSessionName');
    const [expanded, setExpanded] = React.useState<ExpandedField>(null);

    const updateOverride = React.useCallback((
        agent: AgentKey,
        field: AgentDefaultField,
        value: string | null,
    ) => {
        setAgentDefaultOverrides(setAgentDefaultOverride(agentDefaultOverrides, agent, field, value));
    }, [agentDefaultOverrides, setAgentDefaultOverrides]);

    const editClaudeTmuxSessionName = React.useCallback(async () => {
        const value = await Modal.prompt(
            'Claude tmux session',
            'Use tmux for Claude interactive terminals by naming a tmux session.',
            {
                defaultValue: claudeTmuxSessionName ?? '',
                placeholder: 'happy-dev',
            },
        );
        if (value === null) {
            return;
        }

        const trimmed = value.trim();
        if (trimmed.length > 0 && !isValidTmuxSessionName(trimmed)) {
            Modal.alert(
                'Invalid tmux session',
                'Use only letters, numbers, dots, hyphens, and underscores.',
            );
            return;
        }

        setClaudeTmuxSessionName(trimmed.length > 0 ? trimmed : null);
    }, [claudeTmuxSessionName, setClaudeTmuxSessionName]);

    const renderOption = (
        agent: AgentKey,
        field: AgentDefaultField,
        title: string,
        subtitle: string | undefined,
        selected: boolean,
        value: string | null,
    ) => (
        <Item
            key={`${agent}-${field}-${value ?? 'default'}`}
            title={title}
            subtitle={subtitle}
            onPress={() => updateOverride(agent, field, value)}
            showChevron={false}
            rightElement={selected ? (
                <Ionicons name="checkmark" size={20} color={theme.colors.header.tint} />
            ) : undefined}
        />
    );

    const renderField = (agent: AgentKey, config: FieldConfig) => {
        const effectiveDefaults = resolveAgentDefaultConfig(agentDefaultOverrides, agent);
        const effectiveValue = effectiveDefaults[config.field];
        const overrideValue = getAgentDefaultOverrideValue(agentDefaultOverrides, agent, config.field);
        const hasOverride = hasAgentDefaultOverride(agentDefaultOverrides, agent, config.field);
        const isExpanded = expanded?.agent === agent && expanded.field === config.field;
        const detail = hasOverride
            ? optionName(config.options, overrideValue)
            : `Default (${optionName(config.options, effectiveValue)})`;
        const codeDefaultLabel = optionName(config.options, config.codeDefaultKey);

        return (
            <React.Fragment key={`${agent}-${config.field}`}>
                <Item
                    title={config.title}
                    detail={detail}
                    icon={<Ionicons name={config.icon} size={29} color="#5856D6" />}
                    onPress={() => setExpanded(isExpanded ? null : { agent, field: config.field })}
                />
                {isExpanded && (
                    <>
                        {renderOption(
                            agent,
                            config.field,
                            'Use code default',
                            codeDefaultLabel ? codeDefaultLabel : undefined,
                            !hasOverride,
                            null,
                        )}
                        {config.options.map((option) => renderOption(
                            agent,
                            config.field,
                            option.name,
                            option.description ?? undefined,
                            hasOverride && overrideValue === option.key,
                            option.key,
                        ))}
                    </>
                )}
            </React.Fragment>
        );
    };

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <ItemGroup
                title="Agent Defaults"
            >
                <Item
                    title="Clear Overrides"
                    subtitle="Return every agent to code defaults"
                    icon={<Ionicons name="refresh-outline" size={29} color="#FF9500" />}
                    onPress={() => setAgentDefaultOverrides({})}
                    disabled={Object.keys(agentDefaultOverrides).length === 0}
                    showChevron={false}
                />
            </ItemGroup>

            {agentKeys.map((agent) => {
                const codeDefaults = getCodeAgentDefaults(agent);
                const effectiveDefaults = resolveAgentDefaultConfig(agentDefaultOverrides, agent);
                const permissionOptions = getHardcodedPermissionModes(agent, t);
                const modelOptions = getHardcodedModelModes(agent, t).filter((option) => option.key !== 'default');
                const effortOptions = getEffortLevelsForModel(agent, effectiveDefaults.modelMode);
                const fields: FieldConfig[] = [
                    {
                        field: 'permissionMode',
                        title: 'Permission',
                        icon: 'shield-checkmark-outline',
                        options: permissionOptions,
                        codeDefaultKey: codeDefaults.permissionMode,
                    },
                    ...(modelOptions.length > 0 ? [{
                        field: 'modelMode' as const,
                        title: 'Model',
                        icon: 'hardware-chip-outline' as const,
                        options: modelOptions,
                        codeDefaultKey: codeDefaults.modelMode,
                    }] : []),
                    ...(effortOptions.length > 0 ? [{
                        field: 'effortLevel' as const,
                        title: 'Effort',
                        icon: 'speedometer-outline' as const,
                        options: effortOptions,
                        codeDefaultKey: codeDefaults.effortLevel,
                    }] : []),
                ];

                return (
                    <ItemGroup key={agent} title={agentLabels[agent]}>
                        {agent === 'claude' && (
                            <Item
                                title="tmux session"
                                detail={claudeTmuxSessionName ?? 'PTY'}
                                icon={<Ionicons name="terminal-outline" size={29} color="#5856D6" />}
                                onPress={editClaudeTmuxSessionName}
                            />
                        )}
                        {fields.map((field) => renderField(agent, field))}
                    </ItemGroup>
                );
            })}
        </ItemList>
    );
}
