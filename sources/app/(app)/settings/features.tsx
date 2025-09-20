import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import * as React from 'react';
import { Platform, ActivityIndicator, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Switch } from '@/components/Switch';
import { mcpService, MCPModel } from '@/services/mcpService';
import { useSettingMutable, useLocalSettingMutable } from '@/sync/storage';
import { t } from '@/text';


export default function FeaturesSettingsScreen() {
  const { theme } = useUnistyles();
  const router = useRouter();
  const [experiments, setExperiments] = useSettingMutable('experiments');
  const [commandPaletteEnabled, setCommandPaletteEnabled] = useLocalSettingMutable('commandPaletteEnabled');
  const [markdownCopyV2, setMarkdownCopyV2] = useLocalSettingMutable('markdownCopyV2');
  const [defaultCoder, setDefaultCoder] = useSettingMutable('defaultCoder');
  const [anonymousMode, setAnonymousMode] = useSettingMutable('anonymousMode');

  // MCP Model Discovery State
  const [discoveredModels, setDiscoveredModels] = React.useState<MCPModel[]>([]);
  const [modelsLoading, setModelsLoading] = React.useState(false);
  const [modelsError, setModelsError] = React.useState<string | null>(null);
  const [showAllModels, setShowAllModels] = React.useState(false);

  // Discover models on component mount
  React.useEffect(() => {
    const discoverModels = async () => {
      setModelsLoading(true);
      setModelsError(null);
      try {
        const result = await mcpService.discoverModels();
        setDiscoveredModels(result.models);
        if (result.errors && result.errors.length > 0) {
          console.warn('Model discovery warnings:', result.errors);
        }
      } catch (error) {
        console.error('Failed to discover models:', error);
        setModelsError(error instanceof Error ? error.message : 'Unknown error');
      } finally {
        setModelsLoading(false);
      }
    };

    discoverModels();
  }, []);

  // Helper function to get display text for default coder
  const getDefaultCoderDisplay = () => {
    switch (defaultCoder) {
      case 'claude': return t('settingsFeatures.defaultCoderClaude');
      case 'codex': return t('settingsFeatures.defaultCoderCodex');
      case 'ask': return t('settingsFeatures.defaultCoderAsk');
      default: return t('settingsFeatures.defaultCoderClaude');
    }
  };

  // Helper function to cycle to next coder option
  const cycleDefaultCoder = () => {
    const options: Array<'claude' | 'codex' | 'ask'> = ['claude', 'codex', 'ask'];
    const currentIndex = options.indexOf(defaultCoder);
    const nextIndex = (currentIndex + 1) % options.length;
    setDefaultCoder(options[nextIndex]);
  };

  // Helper functions for model management
  const getProviderIcon = (provider: string) => {
    switch (provider.toLowerCase()) {
      case 'anthropic': return '🤖';
      case 'openai': return '🧠';
      case 'google': return '🔍';
      case 'local': return '💻';
      default: return '⚡';
    }
  };

  const getModelCapabilityIcon = (model: MCPModel) => {
    if (model.capabilities.codeGeneration && model.capabilities.codeReview) return 'code-working-outline';
    if (model.capabilities.codeGeneration) return 'code-outline';
    if (model.capabilities.realTimeChat) return 'chatbubbles-outline';
    return 'cube-outline';
  };

  const formatModelSubtitle = (model: MCPModel) => {
    const features = [];
    if (model.capabilities.codeGeneration) features.push('Code');
    if (model.capabilities.imageAnalysis) features.push('Vision');
    if (model.capabilities.toolUse) features.push('Tools');
    if (model.capabilities.webSearch) features.push('Web');

    const contextSize = model.contextWindow >= 1000000
      ? `${Math.round(model.contextWindow / 1000000)}M`
      : `${Math.round(model.contextWindow / 1000)}K`;

    return `${features.join(', ')} • ${contextSize} context`;
  };

  const refreshModels = async () => {
    setModelsLoading(true);
    setModelsError(null);
    try {
      const result = await mcpService.discoverModels(true); // Force refresh
      setDiscoveredModels(result.models);
    } catch (error) {
      console.error('Failed to refresh models:', error);
      setModelsError(error instanceof Error ? error.message : 'Unknown error');
    } finally {
      setModelsLoading(false);
    }
  };

  // Filter models to show - either top 3 or all
  const modelsToShow = showAllModels ? discoveredModels : discoveredModels.slice(0, 3);

  return (
    <ItemList style={{ paddingTop: 0 }}>
      {/* Experimental Features */}
      <ItemGroup 
        title={t('settingsFeatures.experiments')}
        footer={t('settingsFeatures.experimentsDescription')}
      >
        <Item
          title={t('settingsFeatures.experimentalFeatures')}
          subtitle={experiments ? t('settingsFeatures.experimentalFeaturesEnabled') : t('settingsFeatures.experimentalFeaturesDisabled')}
          icon={<Ionicons name="flask-outline" size={29} color="#5856D6" />}
          rightElement={
            <Switch
              value={experiments}
              onValueChange={setExperiments}
            />
          }
          showChevron={false}
        />
        <Item
          title={t('settingsFeatures.markdownCopyV2')}
          subtitle={t('settingsFeatures.markdownCopyV2Subtitle')}
          icon={<Ionicons name="text-outline" size={29} color="#34C759" />}
          rightElement={
            <Switch
              value={markdownCopyV2}
              onValueChange={setMarkdownCopyV2}
            />
          }
          showChevron={false}
        />
      </ItemGroup>

      {/* Default Coder Selection */}
      <ItemGroup
        title={t('settingsFeatures.defaultCoder')}
        footer={t('settingsFeatures.defaultCoderDescription')}
      >
        <Item
          title={t('settingsFeatures.defaultCoder')}
          subtitle={getDefaultCoderDisplay()}
          icon={<Ionicons name="code-outline" size={29} color="#007AFF" />}
          onPress={cycleDefaultCoder}
          showChevron={false}
        />
      </ItemGroup>

      {/* AI Models Discovery */}
      <ItemGroup
        title={t('settingsFeatures.aiModels')}
        footer={t('settingsFeatures.aiModelsDescription')}
      >
        {modelsLoading ? (
          <Item
            title={t('common.loading')}
            subtitle={t('settingsFeatures.discoveringModels')}
            icon={<ActivityIndicator size="small" color={theme.colors.text} />}
            showChevron={false}
          />
        ) : modelsError ? (
          <Item
            title={t('common.error')}
            subtitle={modelsError}
            icon={<Ionicons name="warning-outline" size={29} color={theme.colors.textDestructive} />}
            onPress={refreshModels}
            showChevron={false}
          />
        ) : discoveredModels.length === 0 ? (
          <Item
            title={t('settingsFeatures.noModelsFound')}
            subtitle={t('settingsFeatures.noModelsFoundDescription')}
            icon={<Ionicons name="search-outline" size={29} color={theme.colors.textSecondary} />}
            onPress={refreshModels}
            showChevron={false}
          />
        ) : (
          <>
            {modelsToShow.map((model, index) => (
              <Item
                key={model.id}
                title={`${getProviderIcon(model.provider)} ${model.name}`}
                subtitle={formatModelSubtitle(model)}
                icon={<Ionicons name={getModelCapabilityIcon(model)} size={29} color="#34C759" />}
                detail={model.provider}
                onPress={() => {
                  router.push(`/settings/model-details?modelId=${encodeURIComponent(model.id)}`);
                }}
                showChevron={true}
              />
            ))}

            {/* Show More/Less toggle */}
            {discoveredModels.length > 3 && (
              <Item
                title={showAllModels
                  ? t('settingsFeatures.showLessModels')
                  : t('settingsFeatures.showMoreModels', discoveredModels.length)
                }
                icon={
                  <Ionicons
                    name={showAllModels ? 'chevron-up-outline' : 'chevron-down-outline'}
                    size={29}
                    color={theme.colors.text}
                  />
                }
                onPress={() => setShowAllModels(!showAllModels)}
                showChevron={false}
              />
            )}

            {/* Refresh button */}
            <Item
              title={t('settingsFeatures.refreshModels')}
              subtitle={t('settingsFeatures.refreshModelsDescription')}
              icon={<Ionicons name="refresh-outline" size={29} color="#007AFF" />}
              onPress={refreshModels}
              showChevron={false}
            />
          </>
        )}
      </ItemGroup>

      {/* Privacy Features */}
      <ItemGroup
        title={t('settingsFeatures.privacy')}
        footer={t('settingsFeatures.privacyDescription')}
      >
        <Item
          title={t('password.anonymousMode')}
          subtitle={anonymousMode ? t('password.anonymousModeEnabled') : t('settingsFeatures.anonymousModeDisabled')}
          icon={<Ionicons name="person-outline" size={29} color="#FF9500" />}
          rightElement={
            <Switch
              value={anonymousMode}
              onValueChange={setAnonymousMode}
            />
          }
          showChevron={false}
        />
      </ItemGroup>

      {/* Web-only Features */}
      {Platform.OS === 'web' && (
        <ItemGroup 
          title={t('settingsFeatures.webFeatures')}
          footer={t('settingsFeatures.webFeaturesDescription')}
        >
          <Item
            title={t('settingsFeatures.commandPalette')}
            subtitle={commandPaletteEnabled ? t('settingsFeatures.commandPaletteEnabled') : t('settingsFeatures.commandPaletteDisabled')}
            icon={<Ionicons name="keypad-outline" size={29} color="#007AFF" />}
            rightElement={
              <Switch
                value={commandPaletteEnabled}
                onValueChange={setCommandPaletteEnabled}
              />
            }
            showChevron={false}
          />
        </ItemGroup>
      )}
    </ItemList>
  );
}