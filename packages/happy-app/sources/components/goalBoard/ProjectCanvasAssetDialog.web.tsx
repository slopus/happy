import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { randomUUID } from 'expo-crypto';
import { Modal, ScrollView, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { GOAL_CANVAS_LIMITS, GoalCanvasAssetSchema, GoalProjectCanvasCategorySchema, type GoalProjectCanvasChange } from '@slopus/happy-wire';
import { Typography } from '@/constants/Typography';
import { WebModalBackdrop } from '@/components/WebModalBackdrop';
import { useProjectModalEscape } from '@/hooks/useProjectModalEscape';
import { t } from '@/text';
import { GoalBoardButton as Button } from './GoalBoardButton';

export type CanvasAssetCategory = { id: string; name: string };
export type CanvasManagedAsset = { id: string; name: string; categoryId?: string; x?: number; y?: number };
export type CanvasAssetDialogMode = 'categories' | 'categorize' | 'rename' | 'arrange' | 'delete' | 'package';
type Arrangement = 'left' | 'top' | 'grid' | 'shift';
type CategoryEdit = { type: 'create' } | { type: 'rename' | 'delete'; category: CanvasAssetCategory };

const dialogTitle = {
    categories: 'projectCanvas.manageCategories',
    categorize: 'projectCanvas.categorizeAssets',
    rename: 'projectCanvas.renameAsset',
    arrange: 'projectCanvas.arrangeAssets',
    delete: 'projectCanvas.deleteAssets',
    package: 'projectCanvas.assetPackage',
} as const;
const positionLimit = 1_000_000;
const gridGap = 420;

export function ProjectCanvasAssetDialog({ mode, assets, categories, canExportAll, onClose, onMutation, onImportPackage, onExportPackage }: {
    mode: CanvasAssetDialogMode;
    assets: readonly CanvasManagedAsset[];
    categories: readonly CanvasAssetCategory[];
    canExportAll: boolean;
    onClose: () => void;
    onMutation?: (changes: readonly GoalProjectCanvasChange[]) => Promise<void>;
    onImportPackage?: () => void;
    onExportPackage?: (assetIds?: readonly string[]) => void | Promise<void>;
}) {
    const { theme } = useUnistyles();
    const { width, height } = useWindowDimensions();
    const [categoryEdit, setCategoryEdit] = React.useState<CategoryEdit>();
    const [name, setName] = React.useState(mode === 'rename' ? assets[0]?.name ?? '' : '');
    const [shiftX, setShiftX] = React.useState('');
    const [shiftY, setShiftY] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState<string>();
    const inProgress = React.useRef(false);
    const title = t(dialogTitle[mode]);
    const close = React.useCallback(() => { if (!inProgress.current) onClose(); }, [onClose]);
    useProjectModalEscape(close, busy);
    const initialName = mode === 'rename' ? assets[0]?.name : categoryEdit?.type === 'rename' ? categoryEdit.category.name : '';
    const editingName = (mode === 'rename' || categoryEdit?.type === 'create' || categoryEdit?.type === 'rename') && name !== initialName;
    const backdropDismisses = !editingName && !shiftX && !shiftY && mode !== 'delete' && categoryEdit?.type !== 'delete';

    async function run(action: () => void | Promise<void>, after: () => void) {
        if (inProgress.current) return;
        inProgress.current = true;
        setBusy(true);
        setError(undefined);
        try {
            await action();
            after();
        } catch {
            setError(t(mode === 'package' ? 'projectCanvas.packageExportError' : 'projectCanvas.manageError'));
        } finally {
            inProgress.current = false;
            setBusy(false);
        }
    }
    function mutate(changes: readonly GoalProjectCanvasChange[], after = onClose) {
        if (!onMutation || !changes.length) return;
        void run(() => onMutation(changes), after);
    }
    function renameAsset() {
        const asset = assets[0];
        const text = name.trim();
        if (asset && GoalCanvasAssetSchema.shape.name.safeParse(text).success) mutate([{ type: 'update-asset', assetId: asset.id, name: text }]);
        else setError(t('projectCanvas.invalidName'));
    }
    function editCategory(edit?: CategoryEdit) {
        setCategoryEdit(edit);
        setName(edit?.type === 'rename' ? edit.category.name : '');
        setError(undefined);
    }
    function saveCategory() {
        if (!categoryEdit || categoryEdit.type === 'delete') return;
        const text = name.trim();
        const id = categoryEdit.type === 'rename' ? categoryEdit.category.id : `category-${randomUUID()}`;
        if (!GoalProjectCanvasCategorySchema.shape.name.safeParse(text).success || categories.some(category => category.id !== id && category.name.toLocaleLowerCase() === text.toLocaleLowerCase())) {
            setError(t('projectCanvas.invalidName'));
            return;
        }
        mutate([{ type: 'upsert-category', id, name: text }], () => editCategory());
    }
    function setCategory(categoryId: string | null) {
        mutate(assets.map(asset => ({ type: 'update-asset', assetId: asset.id, categoryId })));
    }
    const positioned = assets.filter((asset): asset is CanvasManagedAsset & { x: number; y: number } =>
        typeof asset.x === 'number' && Number.isFinite(asset.x) && typeof asset.y === 'number' && Number.isFinite(asset.y));
    const canArrange = positioned.length !== 0 && positioned.length === assets.length;
    const horizontal = Number(shiftX);
    const vertical = Number(shiftY);
    const shiftIsValid = canArrange && Number.isFinite(horizontal) && Number.isFinite(vertical)
        && (horizontal !== 0 || vertical !== 0)
        && positioned.every(asset => Math.abs(asset.x + horizontal) <= positionLimit && Math.abs(asset.y + vertical) <= positionLimit);
    function arrange(mode: Arrangement) {
        if (!canArrange) return;
        const left = Math.min(...positioned.map(asset => asset.x));
        const top = Math.min(...positioned.map(asset => asset.y));
        const columns = Math.min(4, Math.ceil(Math.sqrt(positioned.length)));
        const ordered = [...positioned].sort((a, b) => a.y - b.y || a.x - b.x);
        const gridLeft = Math.min(left, positionLimit - (columns - 1) * gridGap);
        const gridTop = Math.min(top, positionLimit - (Math.ceil(positioned.length / columns) - 1) * gridGap);
        mutate(ordered.map((asset, index) => {
            const point = mode === 'grid' ? { x: gridLeft + (index % columns) * gridGap, y: gridTop + Math.floor(index / columns) * gridGap }
                : mode === 'shift' ? { x: asset.x + horizontal, y: asset.y + vertical }
                : mode === 'left' ? { x: left, y: asset.y } : { x: asset.x, y: top };
            return { type: 'update-asset', assetId: asset.id, x: point.x, y: point.y };
        }));
    }

    const field = (label: string, value: string, onChangeText: (value: string) => void, testID: string, numeric = false) =>
        <View style={styles.field}>
            <Text style={styles.fieldLabel}>{label}</Text>
            <TextInput accessibilityLabel={label} testID={testID} editable={!busy} value={value} onChangeText={onChangeText}
                autoFocus={!numeric} inputMode={numeric ? 'decimal' : 'text'} maxLength={numeric ? 14 : 160} style={styles.input} />
        </View>;
    const row = (label: string, icon: React.ComponentProps<typeof Ionicons>['name'], onPress: () => void, testID?: string, disabled = false) =>
        <Button variant="row" label={label} disabled={busy || disabled} onPress={onPress} testID={testID}>
            <Ionicons name={icon} size={17} color={theme.colors.textLink} />
            <Text style={styles.rowText} numberOfLines={2}>{label}</Text>
        </Button>;
    const controls = (label: string, onPress: () => void, testID: string, disabled = false, danger = false, onCancel = close) =>
        <View style={styles.controls}>
            <Button variant="toolbar" label={t('common.cancel')} disabled={busy} onPress={onCancel}><Text style={styles.action}>{t('common.cancel')}</Text></Button>
            <Button variant="primary" label={label} disabled={busy || disabled} busy={busy} testID={testID} onPress={onPress}>
                <Text style={[styles.action, danger && { color: theme.colors.textDestructive }]}>{label}</Text>
            </Button>
        </View>;

    function content() {
        switch (mode) {
            case 'categories':
                if (categoryEdit?.type === 'delete') {
                    return <>
                        <Text style={styles.description}>{t('projectCanvas.confirmDeleteCategory', { name: categoryEdit.category.name })}</Text>
                        {controls(t('projectCanvas.deleteCategory'), () => mutate([{ type: 'delete-category', id: categoryEdit.category.id }], () => editCategory()),
                            'project-canvas-category-delete-confirm', false, true, () => editCategory())}
                    </>;
                }
                if (categoryEdit) {
                    return <>
                        {field(t('projectCanvas.categoryName'), name, setName, 'project-canvas-category-name')}
                        {controls(t('common.save'), saveCategory, 'project-canvas-category-save', !name.trim(), false, () => editCategory())}
                    </>;
                }
                return <>
                    {row(t('projectCanvas.addCategory'), 'add-outline', () => editCategory({ type: 'create' }), 'project-canvas-category-create', categories.length >= GOAL_CANVAS_LIMITS.categories)}
                    {categories.map(category => <View key={category.id} style={styles.categoryRow}>
                        <Text style={styles.categoryText} numberOfLines={2}>{category.name}</Text>
                        <Button variant="toolbar" label={`${t('projectCanvas.renameCategory')} · ${category.name}`} disabled={busy}
                            testID={`project-canvas-category-rename-${category.id}`} onPress={() => editCategory({ type: 'rename', category })}>
                            <Ionicons name="pencil-outline" size={17} color={theme.colors.textSecondary} />
                        </Button>
                        <Button variant="toolbar" label={`${t('projectCanvas.deleteCategory')} · ${category.name}`} disabled={busy}
                            testID={`project-canvas-category-delete-${category.id}`} onPress={() => editCategory({ type: 'delete', category })}>
                            <Ionicons name="trash-outline" size={17} color={theme.colors.textDestructive} />
                        </Button>
                    </View>)}
                </>;
            case 'categorize':
                return <>
                    {row(t('projectCanvas.uncategorized'), 'folder-outline', () => setCategory(null), 'project-canvas-assign-uncategorized', !assets.length)}
                    {categories.map(category => <React.Fragment key={category.id}>
                        {row(category.name, 'folder-outline', () => setCategory(category.id), `project-canvas-assign-${category.id}`, !assets.length)}
                    </React.Fragment>)}
                </>;
            case 'rename':
                return <>
                    {field(t('projectCanvas.assetName'), name, setName, 'project-canvas-asset-name')}
                    {controls(t('common.save'), renameAsset, 'project-canvas-asset-rename-save', !name.trim() || !assets.length)}
                </>;
            case 'arrange':
                return <>
                    {row(t('projectCanvas.alignLeft'), 'list-outline', () => arrange('left'), 'project-canvas-arrange-left', !canArrange || assets.length < 2)}
                    {row(t('projectCanvas.alignTop'), 'reorder-four-outline', () => arrange('top'), 'project-canvas-arrange-top', !canArrange || assets.length < 2)}
                    {row(t('projectCanvas.arrangeGrid'), 'grid-outline', () => arrange('grid'), 'project-canvas-arrange-grid', !canArrange || assets.length < 2)}
                    <View style={styles.offset}>
                        {field(t('projectCanvas.shiftX'), shiftX, setShiftX, 'project-canvas-arrange-shift-x', true)}
                        {field(t('projectCanvas.shiftY'), shiftY, setShiftY, 'project-canvas-arrange-shift-y', true)}
                    </View>
                    {row(t('projectCanvas.shiftAssets'), 'move-outline', () => arrange('shift'), 'project-canvas-arrange-shift', !shiftIsValid)}
                </>;
            case 'delete':
                return <>
                    <Text style={styles.description}>{t('projectCanvas.confirmDeleteAssets', { count: assets.length })}</Text>
                    {controls(t('projectCanvas.deleteAssets'), () => mutate(assets.map(asset => ({ type: 'remove-asset', assetId: asset.id }))),
                        'project-canvas-delete-confirm', !assets.length, true)}
                </>;
            case 'package':
                return <>
                    {onImportPackage && row(t('projectCanvas.importPackage'), 'archive-outline', () => { onClose(); onImportPackage(); }, 'project-canvas-package-import')}
                    {onExportPackage && row(t('projectCanvas.exportPackage'), 'download-outline', () => { void run(() => onExportPackage(), onClose); },
                        'project-canvas-package-export-all', !canExportAll)}
                    {onExportPackage && !!assets.length && row(t('projectCanvas.exportSelectedPackage'), 'download-outline',
                        () => { void run(() => onExportPackage(assets.map(asset => asset.id)), onClose); }, 'project-canvas-package-export-selected')}
                </>;
        }
    }

    return <Modal visible transparent animationType="none" onRequestClose={close} accessibilityLabel={title}>
        <View style={styles.backdrop}>
            <WebModalBackdrop onClose={() => { if (backdropDismisses) close(); }} testID="project-canvas-manage-backdrop" />
            <View accessibilityViewIsModal style={[styles.dialog, { width: Math.min(420, width - 24), maxHeight: Math.floor(height * 0.8) }]}
                testID={`project-canvas-manage-${mode}`}>
                <View style={styles.header}>
                    <Text accessibilityRole="header" style={styles.title}>{title}</Text>
                    <Button variant="icon" label={t('common.cancel')} disabled={busy} onPress={close} testID="project-canvas-manage-close">
                        <Ionicons name="close-outline" size={19} color={theme.colors.textSecondary} />
                    </Button>
                </View>
                <ScrollView style={styles.scroll} contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
                    {content()}
                    {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
                </ScrollView>
            </View>
        </View>
    </Modal>;
}

const styles = StyleSheet.create(theme => ({
    backdrop: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.modal.backdrop },
    dialog: {
        minHeight: 0, flexShrink: 1, overflow: 'hidden', borderRadius: 14,
        borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider, backgroundColor: theme.colors.surface,
        boxShadow: `0 12px 40px ${theme.colors.shadow.color}`,
    },
    header: {
        minHeight: 48, paddingLeft: 14, paddingRight: 6, flexDirection: 'row', alignItems: 'center', gap: 8,
        borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.divider,
    },
    title: { flex: 1, fontSize: 15, lineHeight: 22, color: theme.colors.text, ...Typography.default('semiBold') },
    scroll: { minHeight: 0, flexGrow: 0, flexShrink: 1 },
    body: { padding: 12, gap: 6 },
    categoryRow: { flexDirection: 'row', minHeight: 42, alignItems: 'center', gap: 2, paddingLeft: 7 },
    categoryText: { flex: 1, minWidth: 0, fontSize: 13, lineHeight: 18, color: theme.colors.text },
    field: { flex: 1, minWidth: 0, gap: 5 },
    fieldLabel: { fontSize: 12, lineHeight: 17, color: theme.colors.textSecondary },
    input: {
        minHeight: 38, paddingHorizontal: 10, borderRadius: 8,
        borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider, color: theme.colors.text, backgroundColor: theme.colors.surfaceHigh,
    },
    controls: { marginTop: 8, gap: 6, flexDirection: 'row', justifyContent: 'flex-end', flexWrap: 'wrap' },
    action: { fontSize: 13, lineHeight: 18, color: theme.colors.text },
    rowText: { flex: 1, minWidth: 0, fontSize: 13, lineHeight: 18, color: theme.colors.text, ...Typography.default() },
    description: { paddingVertical: 4, fontSize: 13, lineHeight: 20, color: theme.colors.textSecondary },
    offset: { flexDirection: 'row', alignItems: 'flex-start', gap: 7, marginTop: 4 },
    error: { fontSize: 12, lineHeight: 18, color: theme.colors.textDestructive },
}));
