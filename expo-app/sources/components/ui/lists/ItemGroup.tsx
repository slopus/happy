import * as React from 'react';
import {
    View,
    Text,
    StyleProp,
    ViewStyle,
    TextStyle,
    Platform
} from 'react-native';
import { Typography } from '@/constants/Typography';
import { layout } from '@/components/layout';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { withItemGroupDividers } from './ItemGroup.dividers';
import { countSelectableItems } from './ItemGroup.selectableCount';
import { PopoverBoundaryProvider } from '@/components/ui/popover';

export { withItemGroupDividers } from './ItemGroup.dividers';

export const ItemGroupSelectionContext = React.createContext<{ selectableItemCount: number } | null>(null);

export interface ItemGroupProps {
    title?: string | React.ReactNode;
    footer?: string;
    children: React.ReactNode;
    style?: StyleProp<ViewStyle>;
    headerStyle?: StyleProp<ViewStyle>;
    footerStyle?: StyleProp<ViewStyle>;
    titleStyle?: StyleProp<TextStyle>;
    footerTextStyle?: StyleProp<TextStyle>;
    containerStyle?: StyleProp<ViewStyle>;
    /**
     * Performance: when you already know how many selectable rows are inside the group,
     * pass this to avoid walking the full React children tree on every render.
     */
    selectableItemCountOverride?: number;
}

const stylesheet = StyleSheet.create((theme, runtime) => ({
    wrapper: {
        alignItems: 'center',
    },
    container: {
        width: '100%',
        maxWidth: layout.maxWidth,
        paddingHorizontal: Platform.select({ ios: 0, default: 4 }),
    },
    header: {
        paddingTop: Platform.select({ ios: 26, default: 20 }),
        paddingBottom: Platform.select({ ios: 8, default: 8 }),
        paddingHorizontal: Platform.select({ ios: 32, default: 24 }),
    },
    headerNoTitle: {
        paddingTop: Platform.select({ ios: 20, default: 16 }),
    },
    headerText: {
        ...Typography.default('regular'),
        color: theme.colors.groupped.sectionTitle,
        fontSize: Platform.select({ ios: 13, default: 14 }),
        lineHeight: Platform.select({ ios: 18, default: 20 }),
        letterSpacing: Platform.select({ ios: -0.08, default: 0.1 }),
        textTransform: 'uppercase',
        fontWeight: Platform.select({ ios: 'normal', default: '500' }),
    },
    contentContainerOuter: {
        backgroundColor: theme.colors.surface,
        marginHorizontal: Platform.select({ ios: 16, default: 12 }),
        borderRadius: Platform.select({ ios: 10, default: 16 }),
        // IMPORTANT: allow popovers to overflow this rounded container.
        overflow: 'visible',
        shadowColor: theme.colors.shadow.color,
        shadowOffset: { width: 0, height: 0.33 },
        shadowOpacity: theme.colors.shadow.opacity,
        shadowRadius: 0,
        elevation: 1
    },
    contentContainerInner: {
        borderRadius: Platform.select({ ios: 10, default: 16 }),
    },
    footer: {
        paddingTop: Platform.select({ ios: 6, default: 8 }),
        paddingBottom: Platform.select({ ios: 8, default: 16 }),
        paddingHorizontal: Platform.select({ ios: 32, default: 24 }),
    },
    footerText: {
        ...Typography.default('regular'),
        color: theme.colors.groupped.sectionTitle,
        fontSize: Platform.select({ ios: 13, default: 14 }),
        lineHeight: Platform.select({ ios: 18, default: 20 }),
        letterSpacing: Platform.select({ ios: -0.08, default: 0 }),
    },
}));

export const ItemGroup = React.memo<ItemGroupProps>((props) => {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const popoverBoundaryRef = React.useRef<View>(null);

    const {
        title,
        footer,
        children,
        style,
        headerStyle,
        footerStyle,
        titleStyle,
        footerTextStyle,
        containerStyle,
        selectableItemCountOverride
    } = props;

    const selectableItemCount = React.useMemo(() => {
        if (typeof selectableItemCountOverride === 'number') {
            return selectableItemCountOverride;
        }
        return countSelectableItems(children);
    }, [children, selectableItemCountOverride]);

    const selectionContextValue = React.useMemo(() => {
        return { selectableItemCount };
    }, [selectableItemCount]);

    return (
        <View style={[styles.wrapper, style]}>
            <View style={styles.container}>
                {/* Header */}
                {title ? (
                    <View style={[styles.header, headerStyle]}>
                        {typeof title === 'string' ? (
                            <Text style={[styles.headerText, titleStyle]}>
                                {title}
                            </Text>
                        ) : (
                            title
                        )}
                    </View>
                ) : (
                    // Add top margin when there's no title
                    <View style={styles.headerNoTitle} />
                )}

                {/* Content Container */}
                <View ref={popoverBoundaryRef} style={[styles.contentContainerOuter, containerStyle]}>
                    <PopoverBoundaryProvider boundaryRef={popoverBoundaryRef}>
                        <View style={styles.contentContainerInner}>
                            <ItemGroupSelectionContext.Provider value={selectionContextValue}>
                                {withItemGroupDividers(children)}
                            </ItemGroupSelectionContext.Provider>
                        </View>
                    </PopoverBoundaryProvider>
                </View>

                {/* Footer */}
                {footer && (
                    <View style={[styles.footer, footerStyle]}>
                        <Text style={[styles.footerText, footerTextStyle]}>
                            {footer}
                        </Text>
                    </View>
                )}
            </View>
        </View>
    );
});
