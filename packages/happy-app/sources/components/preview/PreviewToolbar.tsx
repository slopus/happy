import * as React from 'react';
import { View, TextInput, Pressable, Text, Modal } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';

interface PreviewToolbarProps {
    url: string;
    onUrlChange: (url: string) => void;
    onUrlSubmit: () => void;
    inspectMode: boolean;
    onToggleInspect: () => void;
    deviceBarVisible: boolean;
    onToggleDeviceBar: () => void;
    onScreenshot?: () => void;
    screenshotLoading?: boolean;
    onPopOut?: () => void;
    onCopyLink?: () => void;
    onRefresh: () => void;
    onClose: () => void;
}

interface MenuItem {
    icon: string;
    label: string;
    onPress: () => void;
    active?: boolean;
    disabled?: boolean;
}

export const PreviewToolbar = React.memo(({
    url,
    onUrlChange,
    onUrlSubmit,
    inspectMode,
    onToggleInspect,
    deviceBarVisible,
    onToggleDeviceBar,
    onScreenshot,
    screenshotLoading,
    onPopOut,
    onCopyLink,
    onRefresh,
    onClose,
}: PreviewToolbarProps) => {
    const { theme } = useUnistyles();
    const [menuOpen, setMenuOpen] = React.useState(false);
    const menuButtonRef = React.useRef<View>(null);
    const [menuPosition, setMenuPosition] = React.useState({ top: 0, right: 0 });

    const openMenu = React.useCallback(() => {
        if (menuButtonRef.current) {
            menuButtonRef.current.measureInWindow((x, y, width, height) => {
                setMenuPosition({ top: y + height + 4, right: window.innerWidth - x - width });
                setMenuOpen(true);
            });
        } else {
            setMenuOpen(true);
        }
    }, []);

    const closeMenu = React.useCallback(() => setMenuOpen(false), []);

    const menuItems: MenuItem[] = React.useMemo(() => {
        const items: MenuItem[] = [
            {
                icon: 'scan-outline',
                label: 'Inspect',
                onPress: onToggleInspect,
                active: inspectMode,
            },
            {
                icon: 'phone-portrait-outline',
                label: 'Device bar',
                onPress: onToggleDeviceBar,
                active: deviceBarVisible,
            },
        ];

        if (onScreenshot) {
            items.push({
                icon: screenshotLoading ? 'hourglass-outline' : 'camera-outline',
                label: 'Screenshot to chat',
                onPress: onScreenshot,
                disabled: screenshotLoading,
            });
        }

        if (onCopyLink) {
            items.push({
                icon: 'link-outline',
                label: 'Copy link',
                onPress: onCopyLink,
            });
        }

        if (onPopOut) {
            items.push({
                icon: 'open-outline',
                label: 'Pop out',
                onPress: onPopOut,
            });
        }

        return items;
    }, [inspectMode, deviceBarVisible, screenshotLoading, onToggleInspect, onToggleDeviceBar, onScreenshot, onCopyLink, onPopOut]);

    return (
        <View style={styles.container}>
            {/* Close button */}
            <Pressable onPress={onClose} hitSlop={6}>
                <Ionicons
                    name="close-outline"
                    size={20}
                    color={theme.colors.textSecondary}
                />
            </Pressable>

            {/* URL input */}
            <TextInput
                style={[
                    styles.urlInput,
                    {
                        backgroundColor: theme.colors.groupped.background,
                        color: theme.colors.text,
                    },
                ]}
                value={url}
                onChangeText={onUrlChange}
                onSubmitEditing={onUrlSubmit}
                placeholder="http://localhost:3000"
                placeholderTextColor={theme.colors.textSecondary}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                returnKeyType="go"
                selectTextOnFocus
            />

            {/* More menu button */}
            <View ref={menuButtonRef} collapsable={false}>
                <Pressable onPress={openMenu} hitSlop={6}>
                    <Ionicons
                        name="ellipsis-vertical"
                        size={18}
                        color={theme.colors.textSecondary}
                    />
                </Pressable>
            </View>

            {/* Refresh button */}
            <Pressable onPress={onRefresh} hitSlop={6}>
                <Ionicons
                    name="refresh-outline"
                    size={18}
                    color={theme.colors.textSecondary}
                />
            </Pressable>

            {/* Dropdown menu */}
            {menuOpen && (
                <Modal transparent animationType="fade" onRequestClose={closeMenu}>
                    <Pressable style={styles.overlay} onPress={closeMenu}>
                        <View
                            style={[
                                styles.menu,
                                {
                                    backgroundColor: theme.colors.surface,
                                    borderColor: theme.colors.divider,
                                    top: menuPosition.top,
                                    right: menuPosition.right,
                                },
                            ]}
                        >
                            {menuItems.map((item, index) => (
                                <Pressable
                                    key={item.label}
                                    onPress={() => {
                                        closeMenu();
                                        item.onPress();
                                    }}
                                    disabled={item.disabled}
                                    style={({ pressed }) => [
                                        styles.menuItem,
                                        pressed && { backgroundColor: theme.colors.groupped.background },
                                        index < menuItems.length - 1 && {
                                            borderBottomWidth: StyleSheet.hairlineWidth,
                                            borderBottomColor: theme.colors.divider,
                                        },
                                    ]}
                                >
                                    <Ionicons
                                        name={item.icon as any}
                                        size={16}
                                        color={item.active
                                            ? theme.colors.button.primary.background
                                            : item.disabled
                                                ? theme.colors.textTertiary
                                                : theme.colors.textSecondary
                                        }
                                    />
                                    <Text
                                        style={[
                                            styles.menuItemText,
                                            {
                                                color: item.active
                                                    ? theme.colors.button.primary.background
                                                    : item.disabled
                                                        ? theme.colors.textTertiary
                                                        : theme.colors.text,
                                            },
                                        ]}
                                    >
                                        {item.label}
                                    </Text>
                                </Pressable>
                            ))}
                        </View>
                    </Pressable>
                </Modal>
            )}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        height: 44,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 10,
        backgroundColor: theme.colors.surface,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.divider,
    },
    urlInput: {
        flex: 1,
        borderRadius: 8,
        height: 32,
        fontSize: 13,
        ...Typography.mono(),
        paddingHorizontal: 10,
    },
    overlay: {
        flex: 1,
    },
    menu: {
        position: 'absolute',
        minWidth: 180,
        borderRadius: 10,
        borderWidth: 1,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.15,
        shadowRadius: 12,
        elevation: 8,
        overflow: 'hidden',
    },
    menuItem: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingHorizontal: 14,
        paddingVertical: 11,
    },
    menuItemText: {
        fontSize: 14,
        ...Typography.default(),
    },
}));
