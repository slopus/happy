import * as React from 'react';
import { View, Text, Platform } from 'react-native';
import { Pressable } from 'react-native-gesture-handler';
import { Octicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { ModelMode } from './PermissionModeSelector';
import { getModelConfig, getModelTierColor, getModelTierBackgroundColor } from '@/utils/modelDisplay';
import { hapticsLight } from './haptics';

interface ModelIndicatorProps {
  /** Current model mode */
  modelMode?: ModelMode;
  /** Whether this is a Codex session */
  isCodex?: boolean;
  /** Callback when indicator is pressed */
  onPress?: () => void;
  /** Whether to show compact version */
  compact?: boolean;
}

const stylesheet = StyleSheet.create((theme) => ({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: Platform.select({ default: 16, android: 20 }),
    paddingHorizontal: 10,
    paddingVertical: 6,
    justifyContent: 'center',
    height: 32,
    gap: 6,
  },
  icon: {
    marginRight: 2,
  },
  modelName: {
    fontSize: 13,
    fontWeight: '600',
    ...Typography.default('semiBold'),
  },
  contextBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 8,
    marginLeft: 4,
  },
  contextText: {
    fontSize: 10,
    fontWeight: '600',
    ...Typography.default('semiBold'),
  },
}));

/**
 * Visual indicator showing the current AI model with tier-based styling
 */
export const ModelIndicator = React.memo<ModelIndicatorProps>(({
  modelMode,
  isCodex,
  onPress,
  compact = false
}) => {
  const styles = stylesheet;
  const { theme } = useUnistyles();

  // Get effective model mode - use defaults if not specified
  const effectiveMode = modelMode || (isCodex ? 'gpt-5-codex-high' : 'default');
  const config = getModelConfig(effectiveMode);

  // Get tier-based colors
  const tierColor = getModelTierColor(config.tier, theme);
  const tierBgColor = getModelTierBackgroundColor(config.tier, theme);

  const handlePress = React.useCallback(() => {
    if (onPress) {
      hapticsLight();
      onPress();
    }
  }, [onPress]);

  return (
    <Pressable
      onPress={handlePress}
      disabled={!onPress}
      hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
      style={(p) => ({
        ...styles.container,
        backgroundColor: tierBgColor,
        opacity: p.pressed ? 0.7 : 1,
      })}
      accessibilityRole="button"
      accessibilityLabel={`Current model: ${config.name}, ${config.contextWindow}K context`}
      accessibilityHint={onPress ? "Tap to change model" : undefined}
    >
      {/* CPU icon to indicate AI model */}
      <Octicons
        name="cpu"
        size={14}
        color={tierColor}
        style={styles.icon}
      />

      {/* Model name - use short name in compact mode */}
      <Text
        style={[
          styles.modelName,
          { color: tierColor }
        ]}
        numberOfLines={1}
      >
        {compact ? config.shortName : config.name}
      </Text>

      {/* Context window badge */}
      <View
        style={[
          styles.contextBadge,
          { backgroundColor: tierColor }
        ]}
      >
        <Text
          style={[
            styles.contextText,
            { color: '#FFFFFF' }
          ]}
        >
          {config.contextWindow}K
        </Text>
      </View>
    </Pressable>
  );
});

ModelIndicator.displayName = 'ModelIndicator';
