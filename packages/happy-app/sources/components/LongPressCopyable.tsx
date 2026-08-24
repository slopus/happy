import * as React from 'react';
import {
    Modal as RNModal,
    Platform,
    Pressable,
    Text,
    View,
    useWindowDimensions,
    type StyleProp,
    type ViewStyle,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { hapticsLight } from './haptics';
import { AnimatedPopup } from './AnimatedOverlay';

type AnchorRect = {
    height: number;
    width: number;
    x: number;
    y: number;
};

const MENU_WIDTH = 152;
const MENU_HEIGHT = 44;
const MENU_GAP = 8;
const SCREEN_MARGIN = 12;

/**
 * Long-press a block of content to copy it, via a small anchored menu instead of
 * the OS text-selection callout. Web keeps plain mouse selection and renders the
 * children untouched.
 */
export function LongPressCopyable(props: {
    children: React.ReactNode;
    style?: StyleProp<ViewStyle>;
    text: string;
}) {
    const containerRef = React.useRef<View>(null);
    const [anchor, setAnchor] = React.useState<AnchorRect | null>(null);

    const openMenu = React.useCallback(() => {
        const node = containerRef.current;
        if (!node) {
            return;
        }
        node.measureInWindow((x, y, width, height) => {
            setAnchor({ x, y, width, height });
            hapticsLight();
        });
    }, []);

    const closeMenu = React.useCallback(() => setAnchor(null), []);

    // LongPress through GestureDetector (rather than Pressable) so the chat list
    // still pans while a finger is down, matching MarkdownView's copy gesture.
    const gesture = React.useMemo(() => Gesture.LongPress()
        .minDuration(400)
        .onStart(openMenu)
        .runOnJS(true), [openMenu]);

    if (Platform.OS === 'web') {
        return <View style={props.style}>{props.children}</View>;
    }

    return (
        <>
            <GestureDetector gesture={gesture}>
                <View collapsable={false} ref={containerRef} style={props.style}>
                    {props.children}
                </View>
            </GestureDetector>
            {/* Mounted only while open. Rendering it unconditionally would
                subscribe every message in the list to window-size and theme
                changes through CopyMenu's hooks. */}
            {anchor ? <CopyMenu anchor={anchor} onClose={closeMenu} text={props.text} /> : null}
        </>
    );
}

function CopyMenu({ anchor, onClose, text }: {
    anchor: AnchorRect;
    onClose: () => void;
    text: string;
}) {
    const { theme } = useUnistyles();
    const { height: windowHeight, width: windowWidth } = useWindowDimensions();

    const handleCopy = React.useCallback(async () => {
        onClose();
        try {
            await Clipboard.setStringAsync(text);
        } catch (error) {
            console.error('Failed to copy message:', error);
        }
    }, [onClose, text]);

    // Prefer sitting above the message; drop below when the message is close to
    // the top of the screen.
    const above = anchor.y - MENU_HEIGHT - MENU_GAP;
    const top = above >= SCREEN_MARGIN
        ? above
        : Math.min(anchor.y + anchor.height + MENU_GAP, windowHeight - MENU_HEIGHT - SCREEN_MARGIN);
    // User messages hug the right edge, so align the menu's right edge to theirs.
    const left = Math.max(
        SCREEN_MARGIN,
        Math.min(windowWidth - MENU_WIDTH - SCREEN_MARGIN, anchor.x + anchor.width - MENU_WIDTH),
    );

    return (
        <RNModal
            animationType="none"
            onRequestClose={onClose}
            transparent
            visible
        >
            <View style={styles.container}>
                <Pressable onPress={onClose} style={styles.backdrop} />
                <AnimatedPopup style={[styles.menu, { left, top }]}>
                    <Pressable
                        accessibilityLabel={t('common.copy')}
                        accessibilityRole="button"
                        onPress={handleCopy}
                        style={({ pressed }) => [styles.menuItem, pressed && styles.menuItemPressed]}
                    >
                        <Ionicons color={theme.colors.text} name="copy-outline" size={17} />
                        <Text style={styles.menuItemLabel}>{t('common.copy')}</Text>
                    </Pressable>
                </AnimatedPopup>
            </View>
        </RNModal>
    );
}

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
    },
    backdrop: {
        ...StyleSheet.absoluteFillObject,
    },
    menu: {
        position: 'absolute',
        width: MENU_WIDTH,
        borderRadius: 14,
        overflow: 'hidden',
        backgroundColor: theme.colors.surface,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        shadowColor: theme.colors.shadow.color,
        shadowOpacity: theme.colors.shadow.opacity,
        shadowRadius: 16,
        shadowOffset: {
            width: 0,
            height: 6,
        },
        elevation: 8,
    },
    menuItem: {
        height: MENU_HEIGHT,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 14,
        gap: 10,
    },
    menuItemPressed: {
        backgroundColor: theme.colors.surfaceSelected,
    },
    menuItemLabel: {
        ...Typography.default(),
        color: theme.colors.text,
        fontSize: 15,
        lineHeight: 20,
    },
}));
