import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import {
    getEffortLevelsForModel,
    getHardcodedModelModes,
    getHardcodedPermissionModes,
    includeConfiguredModel,
    type ModeOption,
} from '@/components/modelModeOptions';
import { useAllMachines, useSettingMutable } from '@/sync/storage';
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
import { getHarnessName, isRetiredHarness } from '@/utils/harnessCatalog';
import { t } from '@/text';
import { Modal } from '@/modal';
import { collectMachineChoices } from '@/sync/machineChoices';
import { isMachineOnline } from '@/utils/machineUtils';
import { useRouter } from 'expo-router';

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
    claude: getHarnessName('claude'),
    codex: getHarnessName('codex'),
    gemini: getHarnessName('gemini'),
    openclaw: getHarnessName('openclaw'),
    agy: getHarnessName('agy'),
};

// A retired harness keeps its stored defaults — the schema still carries them,
// and "Reset all" still clears them — but there is nothing to configure for an
// agent you can no longer start a session with.
const configurableAgentKeys = agentKeys.filter((agent) => !isRetiredHarness(agent));

function optionName(options: ModeOption[], key: string | null | undefined): string {
    if (!key) return 'none';
    return options.find((option) => option.key === key)?.name ?? key;
}

export default function AgentsSettingsScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const [agentDefaultOverrides, setAgentDefaultOverrides] = useSettingMutable('agentDefaultOverrides');
    const [expanded, setExpanded] = React.useState<ExpandedField>(null);
    const machines = useAllMachines({ includeOffline: true });
    const machineChoices = React.useMemo(() => (
        collectMachineChoices(machines).sort((left, right) => (
            Number(right.online) - Number(left.online)
            || right.activeAt - left.activeAt
        ))
    ), [machines]);

    const updateOverride = React.useCallback((
        agent: AgentKey,
        field: AgentDefaultField,
        value: string | null,
    ) => {
        setAgentDefaultOverrides(setAgentDefaultOverride(agentDefaultOverrides, agent, field, value));
    }, [agentDefaultOverrides, setAgentDefaultOverrides]);

    const editCustomCodexModel = React.useCallback(async (currentValue?: string) => {
        const value = await Modal.prompt(
            'Custom Codex model',
            'Enter an exact model ID. Availability depends on your Codex account or API configuration.',
            {
                defaultValue: currentValue ?? '',
                placeholder: 'model-id',
                confirmText: 'Save',
            },
        );
        const model = value?.trim();
        if (model) {
            updateOverride('codex', 'modelMode', model);
        }
    }, [updateOverride]);

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
        const isCustomCodexModel = agent === 'codex'
            && config.field === 'modelMode'
            && Boolean(overrideValue)
            && !config.options.some((option) => option.key === overrideValue);

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
                        {agent === 'codex' && config.field === 'modelMode' && (
                            <Item
                                title="Custom model…"
                                subtitle={isCustomCodexModel ? overrideValue : 'Enter an exact model ID'}
                                onPress={() => editCustomCodexModel(isCustomCodexModel ? overrideValue : undefined)}
                                showChevron={false}
                                rightElement={isCustomCodexModel ? (
                                    <Ionicons name="checkmark" size={20} color={theme.colors.header.tint} />
                                ) : undefined}
                            />
                        )}
                    </>
                )}
            </React.Fragment>
        );
    };

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <ItemGroup title="Machines">
                {machineChoices.length === 0 ? (
                    <Item
                        title="No connected machines"
                        subtitle="Run Happy on a computer to connect it"
                        icon={<Ionicons name="desktop-outline" size={29} color={theme.colors.textSecondary} />}
                        disabled
                        showChevron={false}
                    />
                ) : machineChoices.map((choice) => {
                    const machine = choice.happyMachine ?? choice.rigMachine;
                    const platform = machine?.metadata?.platform?.trim();
                    const subtitle = [platform, choice.online ? t('status.online') : t('status.offline')]
                        .filter(Boolean)
                        .join(' • ');
                    const targetMachine = [choice.happyMachine, choice.rigMachine]
                        .find((candidate) => candidate && isMachineOnline(candidate))
                        ?? machine;

                    return (
                        <Item
                            key={choice.id}
                            title={choice.name}
                            subtitle={subtitle}
                            icon={
                                <Ionicons
                                    name="desktop-outline"
                                    size={29}
                                    color={choice.online
                                        ? theme.colors.status.connected
                                        : theme.colors.status.disconnected}
                                />
                            }
                            style={{ opacity: choice.online ? 1 : 0.5 }}
                            onPress={targetMachine
                                ? () => router.push(`/machine/${targetMachine.id}`)
                                : undefined}
                        />
                    );
                })}
            </ItemGroup>

            <ItemGroup
                title="Defaults"
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

            {configurableAgentKeys.map((agent) => {
                const codeDefaults = getCodeAgentDefaults(agent);
                const effectiveDefaults = resolveAgentDefaultConfig(agentDefaultOverrides, agent);
                const permissionOptions = getHardcodedPermissionModes(agent, t);
                const modelOptions = includeConfiguredModel(
                    agent,
                    getHardcodedModelModes(agent, t),
                    effectiveDefaults.modelMode,
                ).filter((option) => option.key !== 'default');
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
                        {fields.map((field) => renderField(agent, field))}
                    </ItemGroup>
                );
            })}
        </ItemList>
    );
}
