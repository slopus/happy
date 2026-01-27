import * as React from 'react';
import { Platform, Text, TextInput, View, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { Popover, type PopoverPlacement } from '@/components/ui/popover';
import { FloatingOverlay } from '@/components/FloatingOverlay';
import { t } from '@/text';
import type { SelectableRowVariant } from '@/components/ui/lists/SelectableRow';
import { SelectableMenuResults } from '@/components/ui/forms/dropdown/SelectableMenuResults';
import type { SelectableMenuItem } from '@/components/ui/forms/dropdown/selectableMenuTypes';
import { useSelectableMenu } from '@/components/ui/forms/dropdown/useSelectableMenu';

export type DropdownMenuItem = Readonly<{
    id: string;
    title: string;
    subtitle?: string;
    category?: string;
    icon?: React.ReactNode;
    shortcut?: string;
    disabled?: boolean;
}>;

export type DropdownMenuProps = Readonly<{
    /**
     * The trigger element.
     * Prefer the render-prop form so DropdownMenu can provide a consistent `toggle()` helper.
     * A ref will be attached internally for anchoring (the trigger is rendered inside that host).
     */
    trigger:
        | React.ReactNode
        | ((props: Readonly<{
            open: boolean;
            toggle: () => void;
            openMenu: () => void;
            closeMenu: () => void;
        }>) => React.ReactNode);
    open: boolean;
    onOpenChange: (next: boolean) => void;

    items: ReadonlyArray<DropdownMenuItem>;
    onSelect: (itemId: string) => void;
    /**
     * Optional: the currently-selected item ID. Used for initial keyboard highlight.
     * If it points to a disabled item, it is ignored.
     */
    selectedId?: string | null;

    /**
     * Visual style of rows:
     * - slim: compact action-list feel
     * - default: standard app row
     * - selectable: CommandPalette-style (hover/selected borders)
     */
    variant?: SelectableRowVariant;
    /** When true, shows a search field and enables keyboard navigation on web. */
    search?: boolean;
    searchPlaceholder?: string;
    emptyLabel?: string;
    placement?: PopoverPlacement;
    /** Gap between the trigger and the menu (default 0 for dropdown feel). */
    gap?: number;
    maxHeightCap?: number;
    maxWidthCap?: number;
    /** Match the popover width to the trigger width in web portal mode (default true). */
    matchTriggerWidth?: boolean;
    popoverBoundaryRef?: React.RefObject<any> | null;
    /**
     * Web-only: controls where the popover portal is mounted.
     * Defaults to Popover's behavior (which prefers the modal portal target when inside a modal).
     * Set to 'body' to allow menus to escape overflow-clipped modals.
     */
    popoverPortalWebTarget?: 'body' | 'modal' | 'boundary';
    overlayStyle?: ViewStyle;
    /** When false, category titles like "General" are not rendered. */
    showCategoryTitles?: boolean;
    /** Render rows using the app `Item` component for perfect icon/typography parity. */
    rowKind?: 'selectableRow' | 'item';
    /**
     * Make the menu visually connect to the trigger (no gap; squared top corners; no top border).
     * Intended for "dropdown" inputs where the menu should feel like a single control.
     */
    connectToTrigger?: boolean;
}>;

export function DropdownMenu(props: DropdownMenuProps) {
    const { theme } = useUnistyles();
    const anchorRef = React.useRef<View>(null);

    const rowVariant: SelectableRowVariant = props.variant ?? 'slim';
    const matchTriggerWidth = props.matchTriggerWidth ?? true;
    const maxWidthCap = props.maxWidthCap ?? (matchTriggerWidth ? 1024 : 320);
    const edgePadding = React.useMemo(() => {
        // When the menu is meant to visually "connect" to the trigger, horizontal edge padding
        // creates an inset that makes the popover look misaligned. Keep vertical breathing room.
        if (props.connectToTrigger || matchTriggerWidth) return { vertical: 8, horizontal: 0 } as const;
        return { vertical: 8, horizontal: 8 } as const;
    }, [matchTriggerWidth, props.connectToTrigger]);

    const selectableItems = React.useMemo((): SelectableMenuItem[] => {
        return props.items.map((item) => ({
            id: item.id,
            title: item.title,
            subtitle: item.subtitle,
            category: item.category,
            disabled: item.disabled,
            left: item.icon ?? null,
            right: item.shortcut
                ? (
                    <View style={{ paddingHorizontal: 10, paddingVertical: 5, backgroundColor: 'rgba(0, 0, 0, 0.04)', borderRadius: 6 }}>
                        <Text style={{ fontSize: 12, color: '#666', fontWeight: '500' }}>
                            {item.shortcut}
                        </Text>
                    </View>
                )
                : (
                    <Ionicons
                        name="chevron-forward"
                        size={18}
                        color={theme.colors.textSecondary}
                        style={{ opacity: rowVariant === 'slim' ? 0 : 1 }}
                    />
                ),
        }));
    }, [props.items, rowVariant, theme.colors.textSecondary]);

    const onRequestClose = React.useCallback(() => props.onOpenChange(false), [props]);
    const schedule = React.useCallback((cb: () => void) => {
        // Opening an overlay on the same click can sometimes immediately trigger a backdrop close
        // (especially on web). Deferring by one tick ensures the opening press completes first.
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(cb);
            return;
        }
        setTimeout(cb, 0);
    }, []);
    const openMenu = React.useCallback(() => {
        schedule(() => props.onOpenChange(true));
    }, [props, schedule]);
    const closeMenu = React.useCallback(() => props.onOpenChange(false), [props]);
    const toggle = React.useCallback(() => {
        if (props.open) {
            props.onOpenChange(false);
            return;
        }
        openMenu();
    }, [openMenu, props]);
    const triggerNode = React.useMemo(() => {
        if (typeof props.trigger === 'function') {
            return props.trigger({
                open: props.open,
                toggle,
                openMenu,
                closeMenu,
            });
        }
        return props.trigger;
    }, [closeMenu, openMenu, props, toggle]);

    const {
        searchQuery,
        selectedIndex,
        filteredCategories,
        inputRef,
        handleSearchChange,
        handleKeyPress,
        setSelectedIndex,
    } = useSelectableMenu({
        items: selectableItems,
        onRequestClose,
        initialSelectedId: props.selectedId ?? null,
    });

    const handleKeyDown = React.useCallback((e: any) => {
        if (Platform.OS !== 'web') return;
        const key = e?.nativeEvent?.key;
        if (typeof key !== 'string') return;
        if (!['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(key)) return;
        e.preventDefault?.();
        e.stopPropagation?.();
        handleKeyPress(key, (item) => {
            props.onOpenChange(false);
            props.onSelect(item.id);
        });
    }, [handleKeyPress, props]);

    return (
        <View
            ref={anchorRef}
            // Ensure this wrapper exists in the native hierarchy so `measureInWindow` is reliable.
            // Without this, RN can "collapse" the View and measurement can return 0x0, causing
            // dropdowns to overlap their trigger (notably on iOS).
            collapsable={false}
            style={{ position: 'relative' }}
        >
            {triggerNode}
            {props.open ? (
                <Popover
                    open={props.open}
                    anchorRef={anchorRef}
                    placement={props.placement ?? 'bottom'}
                    gap={props.gap ?? 0}
                    maxHeightCap={props.maxHeightCap ?? 320}
                    maxWidthCap={maxWidthCap}
                    edgePadding={edgePadding}
                    portal={{
                        web: props.popoverPortalWebTarget ? { target: props.popoverPortalWebTarget } : true,
                        native: true,
                        matchAnchorWidth: matchTriggerWidth,
                        anchorAlignVertical: 'start',
                    }}
                    boundaryRef={props.popoverBoundaryRef}
                    onRequestClose={onRequestClose}
                >
                    {({ maxHeight, maxWidth }) => (
                        <FloatingOverlay
                            maxHeight={maxHeight}
                            edgeFades={{ top: true, bottom: true }}
                            edgeIndicators={{ size: 14, opacity: 0.35 }}
                            containerStyle={[
                                // Dropdowns should be shadow-only (no borders).
                                { borderWidth: 0, borderColor: 'transparent' } as any,
                                props.connectToTrigger
                                    ? ({
                                        borderTopLeftRadius: 0,
                                        borderTopRightRadius: 0,
                                        marginTop: -1,
                                        borderTopWidth: 0,
                                    } as any)
                                    : null,
                                props.overlayStyle ?? null,
                            ]}
                        >
                            {props.search ? (
                                <View style={{
                                    paddingHorizontal: rowVariant === 'slim' ? 12 : 16,
                                    paddingTop: rowVariant === 'slim' ? 8 : 10,
                                    paddingBottom: rowVariant === 'slim' ? 6 : 8,
                                }}>
                                    <TextInput
                                        ref={inputRef as any}
                                        value={searchQuery}
                                        onChangeText={handleSearchChange}
                                        placeholder={props.searchPlaceholder ?? t('commandPalette.placeholder')}
                                        placeholderTextColor="#999"
                                        autoCorrect={false}
                                        autoCapitalize="none"
                                        autoFocus
                                        onKeyPress={handleKeyDown}
                                        style={{
                                            borderRadius: rowVariant === 'slim' ? 8 : 10,
                                            borderWidth: 1,
                                            borderColor: theme.colors.divider,
                                            paddingHorizontal: rowVariant === 'slim' ? 10 : 12,
                                            paddingVertical: rowVariant === 'slim' ? 8 : 10,
                                            fontSize: rowVariant === 'slim' ? 14 : 15,
                                            color: theme.colors.text,
                                        }}
                                    />
                                </View>
                            ) : null}

                            <SelectableMenuResults
                                categories={filteredCategories}
                                selectedIndex={selectedIndex}
                                onSelectionChange={setSelectedIndex}
                                onPressItem={(item) => {
                                    props.onOpenChange(false);
                                    props.onSelect(item.id);
                                }}
                                rowVariant={rowVariant}
                                emptyLabel={props.emptyLabel ?? t('commandPalette.noCommandsFound')}
                                showCategoryTitles={props.showCategoryTitles}
                                rowKind={props.rowKind}
                            />
                        </FloatingOverlay>
                    )}
                </Popover>
            ) : null}
        </View>
    );
}
