import * as React from 'react';
import { View, Text, Pressable, Modal, Platform, Dimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Typography } from '@/constants/Typography';
import { useUnistyles, StyleSheet } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export interface ContextMenuAction {
    id: string;
    title: string;
    icon?: string;
    destructive?: boolean;
    disabled?: boolean;
    onPress: () => void;
}

interface ContextMenuProps {
    visible: boolean;
    onClose: () => void;
    actions: ContextMenuAction[];
    anchorPosition?: { x: number; y: number };
    title?: string;
}

export const ContextMenu: React.FC<ContextMenuProps> = ({
  visible,
  onClose,
  actions,
  anchorPosition,
  title,
}) => {
  const { theme } = useUnistyles();
  const safeArea = useSafeAreaInsets();
  const [menuPosition, setMenuPosition] = React.useState({ x: 0, y: 0 });
  const [menuSize, setMenuSize] = React.useState({ width: 0, height: 0 });

  // Calculate menu position based on anchor and screen bounds
  React.useEffect(() => {
    if (!visible || !anchorPosition) return;

    const screenWidth = Dimensions.get('window').width;
    const screenHeight = Dimensions.get('window').height;

    // Estimate menu dimensions
    const estimatedWidth = 250;
    const estimatedHeight = (actions.length * 50) + (title ? 60 : 20) + safeArea.bottom;

    let x = anchorPosition.x;
    let y = anchorPosition.y;

    // Adjust horizontal position if menu would overflow
    if (x + estimatedWidth > screenWidth - 20) {
      x = screenWidth - estimatedWidth - 20;
    }
    if (x < 20) {
      x = 20;
    }

    // Adjust vertical position if menu would overflow
    if (y + estimatedHeight > screenHeight - 20) {
      y = screenHeight - estimatedHeight - 20;
    }
    if (y < safeArea.top + 20) {
      y = safeArea.top + 20;
    }

    setMenuPosition({ x, y });
  }, [visible, anchorPosition, actions.length, title, safeArea]);

  const handleActionPress = (action: ContextMenuAction) => {
    if (action.disabled) return;
    onClose();
    // Small delay to ensure modal closes before action
    setTimeout(() => action.onPress(), 100);
  };

  const handleOverlayPress = () => {
    onClose();
  };

  if (!visible) return null;

  return (
    <Modal
      visible={visible}
      transparent={true}
      animationType="fade"
      onRequestClose={onClose}
    >
      {/* Overlay */}
      <Pressable style={styles.overlay} onPress={handleOverlayPress}>
        {/* Menu Container */}
        <View
          style={[
            styles.menuContainer,
            {
              backgroundColor: theme.colors.surface,
              borderColor: theme.colors.divider,
              left: menuPosition.x,
              top: menuPosition.y,
            },
            Platform.OS === 'web' && styles.webShadow,
          ]}
          onLayout={(event) => {
            const { width, height } = event.nativeEvent.layout;
            setMenuSize({ width, height });
          }}
        >
          {/* Title */}
          {title && (
            <View style={[styles.titleContainer, { borderBottomColor: theme.colors.divider }]}>
              <Text style={[styles.titleText, { color: theme.colors.text }]}>
                {title}
              </Text>
            </View>
          )}

          {/* Actions */}
          <View style={styles.actionsContainer}>
            {actions.map((action, index) => (
              <Pressable
                key={action.id}
                style={({ pressed }) => [
                  styles.actionItem,
                  { backgroundColor: pressed ? theme.colors.input.background : 'transparent' },
                  action.disabled && styles.actionItemDisabled,
                  index < actions.length - 1 && {
                    borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                    borderBottomColor: theme.colors.divider,
                  },
                ]}
                onPress={() => handleActionPress(action)}
                disabled={action.disabled}
              >
                <View style={styles.actionContent}>
                  {action.icon && (
                    <Ionicons
                      name={action.icon as any}
                      size={20}
                      color={
                        action.disabled
                          ? theme.colors.textSecondary
                          : action.destructive
                            ? '#FF3B30'
                            : theme.colors.text
                      }
                      style={styles.actionIcon}
                    />
                  )}
                  <Text
                    style={[
                      styles.actionText,
                      {
                        color: action.disabled
                          ? theme.colors.textSecondary
                          : action.destructive
                            ? '#FF3B30'
                            : theme.colors.text,
                      },
                    ]}
                  >
                    {action.title}
                  </Text>
                </View>
              </Pressable>
            ))}
          </View>
        </View>
      </Pressable>
    </Modal>
  );
};

// Hook for managing context menu state
export const useContextMenu = () => {
  const [visible, setVisible] = React.useState(false);
  const [anchorPosition, setAnchorPosition] = React.useState<{ x: number; y: number } | undefined>();

  const show = React.useCallback((position?: { x: number; y: number }) => {
    setAnchorPosition(position);
    setVisible(true);
  }, []);

  const hide = React.useCallback(() => {
    setVisible(false);
    setAnchorPosition(undefined);
  }, []);

  return { visible, anchorPosition, show, hide };
};

const styles = StyleSheet.create((theme) => ({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
  },
  menuContainer: {
    position: 'absolute',
    minWidth: Platform.select({ ios: 220, android: 240, default: 260 }),
    maxWidth: Platform.select({ ios: 320, android: 300, default: 340 }),
    borderRadius: Platform.select({ ios: 14, android: 8, default: 12 }),
    borderWidth: Platform.select({ ios: 0.33, android: 0, default: 1 }),
    overflow: 'hidden',
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 12 },
        shadowOpacity: 0.3,
        shadowRadius: 20,
      },
      android: {
        elevation: 16,
      },
      web: {
        boxShadow: '0 12px 40px rgba(0, 0, 0, 0.25), 0 4px 16px rgba(0, 0, 0, 0.15)',
      },
    }),
  },
  webShadow: {
    boxShadow: '0 4px 12px rgba(0, 0, 0, 0.25)',
  },
  titleContainer: {
    paddingHorizontal: Platform.select({ ios: 16, android: 20, default: 18 }),
    paddingVertical: Platform.select({ ios: 14, android: 16, default: 15 }),
    borderBottomWidth: Platform.select({ ios: 0.33, android: 1, default: 1 }),
  },
  titleText: {
    fontSize: Platform.select({ ios: 16, android: 17, default: 16 }),
    fontWeight: Platform.select({ ios: '600', android: '500', default: '600' }),
    textAlign: 'center',
    ...Typography.default('semiBold'),
  },
  actionsContainer: {
    paddingVertical: Platform.select({ ios: 6, android: 8, default: 8 }),
  },
  actionItem: {
    paddingHorizontal: Platform.select({ ios: 16, android: 20, default: 18 }),
    paddingVertical: Platform.select({ ios: 12, android: 14, default: 13 }),
    minHeight: Platform.select({ ios: 48, android: 52, default: 50 }),
    justifyContent: 'center',
  },
  actionItemDisabled: {
    opacity: 0.5,
  },
  actionContent: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  actionIcon: {
    marginRight: 12,
  },
  actionText: {
    fontSize: 16,
    flex: 1,
    ...Typography.default(),
  },
}));