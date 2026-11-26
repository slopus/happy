import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { ScrollView, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { GoalProjectCanvasChange } from '@slopus/happy-wire';
import { PanelTabs } from '@/components/PanelTabs';
import { Typography } from '@/constants/Typography';
import { getCurrentLanguage, t } from '@/text';
import { GoalBoardButton as Button } from './GoalBoardButton';
import { ProjectCanvasAssetDialog, type CanvasAssetCategory, type CanvasAssetDialogMode, type CanvasManagedAsset } from './ProjectCanvasAssetDialog.web';

type CanvasToolAsset = CanvasManagedAsset & { mimeType: string; size: number; uri?: string };
const noCategories: readonly CanvasAssetCategory[] = [];
const uncategorizedOption = '@uncategorized';

export type ProjectCanvasToolsProps = {
    assets: readonly CanvasToolAsset[];
    activeAssetId?: string;
    selectedAssetIds?: readonly string[];
    categories?: readonly CanvasAssetCategory[];
    categoryFilter?: string | null;
    onCategoryFilterChange?(categoryId: string | null | undefined): void;
    onMutation?(changes: readonly GoalProjectCanvasChange[]): Promise<void>;
    onImportPackage?(): void;
    onExportPackage?(assetIds?: readonly string[]): void | Promise<void>;
    files?: React.ReactNode;
    disabled?: boolean;
    canAddResult?: boolean;
    previewVisible: boolean;
    onPreviewAsset(id: string): void;
    onImport(): void;
    onAddResult(): void;
    onFocusAsset(id: string): void;
    onFit(): void;
    onZoom(direction: 'in' | 'out'): void;
};

export function ProjectCanvasTools({
    assets, activeAssetId, selectedAssetIds, categories = noCategories, categoryFilter, onCategoryFilterChange,
    onMutation, onImportPackage, onExportPackage, files, disabled, canAddResult, previewVisible,
    onPreviewAsset, onImport, onAddResult, onFocusAsset, onFit, onZoom,
}: ProjectCanvasToolsProps) {
    const { theme } = useUnistyles();
    const [tab, setTab] = React.useState('assets');
    const [openedFiles, setOpenedFiles] = React.useState(false);
    const fileTab = Boolean(files) && tab === 'files';
    const [selectionMode, setSelectionMode] = React.useState(false);
    const [selection, setSelection] = React.useState<ReadonlySet<string>>(() => new Set());
    const [dialog, setDialog] = React.useState<CanvasAssetDialogMode>();
    const closeDialog = React.useCallback(() => setDialog(undefined), []);
    const filter = typeof categoryFilter === 'string' && !categories.some(category => category.id === categoryFilter) ? undefined : categoryFilter;
    const visibleAssets = React.useMemo(() => filter === undefined ? assets
        : assets.filter(asset => (asset.categoryId ?? null) === filter), [assets, filter]);
    const selected = assets.filter(asset => selection.has(asset.id));
    const canSelect = !!(onMutation || onExportPackage);
    const canUsePackages = !!(onImportPackage || onExportPackage);
    const list = React.useRef<HTMLDivElement>(null);

    function toggleSelectionMode() {
        setSelectionMode(!selectionMode);
        const frameSelection = selectedAssetIds?.length ? selectedAssetIds : activeAssetId ? [activeAssetId] : [];
        setSelection(new Set(selectionMode ? [] : frameSelection));
    }
    function toggleAsset(assetId: string) {
        setSelection(previous => {
            const next = new Set(previous);
            if (next.has(assetId)) next.delete(assetId);
            else next.add(assetId);
            return next;
        });
    }
    React.useEffect(() => {
        if (!previewVisible || fileTab || !list.current) return;
        const pending = Array.from(list.current.querySelectorAll<HTMLElement>('[data-preview-asset]'));
        const request = (element: HTMLElement) => {
            const id = element.dataset.previewAsset;
            if (id) onPreviewAsset(id);
        };
        if (typeof IntersectionObserver === 'undefined') {
            pending.slice(0, 12).forEach(request);
            return;
        }
        const observer = new IntersectionObserver(entries => {
            for (const entry of entries) {
                if (!entry.isIntersecting || !(entry.target instanceof HTMLElement)) continue;
                observer.unobserve(entry.target);
                request(entry.target);
            }
        });
        pending.forEach(element => observer.observe(element));
        return () => observer.disconnect();
    }, [visibleAssets, fileTab, onPreviewAsset, previewVisible]);
    const language = getCurrentLanguage();
    const units = React.useMemo(() => ({
        bytes: new Intl.NumberFormat(language, { style: 'unit', unit: 'byte', unitDisplay: 'short' }),
        kilobytes: new Intl.NumberFormat(language, { style: 'unit', unit: 'kilobyte', unitDisplay: 'short', maximumFractionDigits: 0 }),
        megabytes: new Intl.NumberFormat(language, { style: 'unit', unit: 'megabyte', unitDisplay: 'short', maximumFractionDigits: 1 }),
    }), [language]);
    const assetSize = (size: number) => size < 1024 ? units.bytes.format(size) : size < 1024 * 1024
        ? units.kilobytes.format(size / 1024) : units.megabytes.format(size / (1024 * 1024));
    const text = theme.colors.text;
    const secondary = theme.colors.textSecondary;
    const assetsTitle = t('projectCanvas.assets');
    const selectAssetLabel = t(selectionMode ? 'projectCanvas.finishSelection' : 'projectCanvas.selectAssets');
    const action = (label: string, icon: React.ComponentProps<typeof Ionicons>['name'], press: () => void, testID: string, unavailable = false, selected = false) =>
        <Button variant="toolbar" label={label} tooltip={label} tooltipPortal disabled={disabled || unavailable} selected={selected} onPress={press} testID={testID}>
            <Ionicons name={icon} size={17} color={selected ? theme.colors.textLink : secondary} />
        </Button>;

    return <View style={styles.panel} testID="project-canvas-tools">
        <View style={styles.header}>
            <Ionicons name="options-outline" size={17} color={theme.colors.textLink} />
            <Text accessibilityRole="header" numberOfLines={1} style={styles.title}>{t('projectCanvas.tools')}</Text>
            <View style={styles.headerSpace} />
            <View style={styles.count} accessibilityLabel={`${assetsTitle} · ${assets.length}`}>
                <Text style={styles.countText}>{assets.length}</Text>
            </View>
        </View>
        <View style={styles.tabs}>
            {files ? <PanelTabs activeTab={fileTab ? 'files' : 'assets'} onTabChange={key => {
                setTab(key);
                if (key === 'files') setOpenedFiles(true);
            }} testIDPrefix="project-canvas-tools" tabs={[
                { key: 'assets', label: assetsTitle, icon: 'images-outline' },
                { key: 'files', label: t('projectCanvas.projectFiles'), icon: 'folder-outline' },
            ]} /> : <Text style={[styles.title, styles.assetsTitle]}>{assetsTitle}</Text>}
        </View>
        <View style={[styles.body, fileTab && styles.hidden]}>
            {(onCategoryFilterChange || onMutation || canSelect) && <View style={styles.management}>
                <View style={styles.filterRow}>
                    {onCategoryFilterChange && <select aria-label={t('projectCanvas.filterCategory')}
                        data-testid="project-canvas-category-filter" value={filter === null ? uncategorizedOption : filter ?? ''}
                        onChange={event => {
                            const value = event.currentTarget.value;
                            onCategoryFilterChange(value === uncategorizedOption ? null : value || undefined);
                        }}
                        style={{ flex: 1, minWidth: 0, width: 0, height: 36, padding: '0 7px', borderRadius: 8, boxSizing: 'border-box',
                            border: '1px solid ' + theme.colors.divider, backgroundColor: theme.colors.surfaceHigh,
                            color: text, outlineColor: theme.colors.textLink, font: 'inherit', fontSize: 12, colorScheme: theme.dark ? 'dark' : 'light' }}>
                        <option value="">{t('projectCanvas.allCategories')}</option>
                        <option value={uncategorizedOption}>{t('projectCanvas.uncategorized')}</option>
                        {categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}
                    </select>}
                    {onMutation && action(t('projectCanvas.manageCategories'), 'folder-open-outline', () => setDialog('categories'), 'project-canvas-manage-categories')}
                    {canSelect && action(selectAssetLabel, selectionMode ? 'checkbox-outline' : 'square-outline', toggleSelectionMode,
                        'project-canvas-selection-toggle', !selectionMode && !assets.length, selectionMode)}
                </View>
                {selectionMode && <View style={styles.selection}>
                    <View style={styles.selectionStatus}>
                        <Text accessibilityLiveRegion="polite" style={styles.selectionCount}>{t('projectCanvas.selectionCount', { count: selected.length })}</Text>
                        {action(t('projectCanvas.selectVisibleAssets'), 'checkmark-done-outline',
                            () => setSelection(previous => new Set([...previous, ...visibleAssets.map(asset => asset.id)])),
                            'project-canvas-select-visible', !visibleAssets.length || visibleAssets.every(asset => selection.has(asset.id)))}
                        {action(t('projectCanvas.clearAssetSelection'), 'close-outline', () => setSelection(new Set()),
                            'project-canvas-selection-clear', !selected.length)}
                    </View>
                    {onMutation && <View style={styles.selectionActions}>
                        {action(t('projectCanvas.categorizeAssets'), 'folder-outline', () => setDialog('categorize'), 'project-canvas-batch-categorize', !selected.length)}
                        {action(t('projectCanvas.renameAsset'), 'pencil-outline', () => setDialog('rename'), 'project-canvas-batch-rename', selected.length !== 1)}
                        {action(t('projectCanvas.arrangeAssets'), 'grid-outline', () => setDialog('arrange'), 'project-canvas-batch-arrange', !selected.length)}
                        {action(t('projectCanvas.deleteAssets'), 'trash-outline', () => setDialog('delete'), 'project-canvas-batch-delete', !selected.length)}
                    </View>}
                </View>}
            </View>}
            {visibleAssets.length ? <div ref={list} style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                <ScrollView style={styles.body} contentContainerStyle={styles.list}>
                    {visibleAssets.map(asset => <div key={asset.id} data-preview-asset={asset.uri ? undefined : asset.id}>
                        <CanvasToolRow asset={asset} size={assetSize(asset.size)} selected={selectionMode ? selection.has(asset.id) : activeAssetId === asset.id}
                            selecting={selectionMode} category={categories.find(category => category.id === asset.categoryId)?.name}
                            disabled={disabled} onPress={() => selectionMode ? toggleAsset(asset.id) : onFocusAsset(asset.id)} />
                    </div>)}
                </ScrollView>
            </div> : <View style={styles.empty}>
                <View style={styles.emptyIcon}><Ionicons name="images-outline" size={21} color={secondary} /></View>
                <Text style={styles.title}>{t(filter === undefined ? 'projectCanvas.emptyTitle' : 'projectCanvas.noFilteredAssets')}</Text>
                {filter === undefined && <Text style={styles.emptyText}>{t('projectCanvas.emptyHint')}</Text>}
            </View>}
        </View>
        {files && openedFiles && <View style={[styles.body, !fileTab && styles.hidden]}>{files}</View>}
        <View style={styles.footer}>
            <View style={styles.importActions}>
                <View style={styles.importPrimary}>
                    <Button variant="primary" label={t('projectCanvas.importImages')} testID="project-canvas-import" disabled={disabled} onPress={onImport}>
                        <Ionicons name="add-outline" size={18} color={text} />
                        <Text numberOfLines={2} style={styles.actionText}>{t('projectCanvas.importImages')}</Text>
                    </Button>
                </View>
                {canUsePackages && <Button variant="toolbar" label={t('projectCanvas.assetPackage')} testID="project-canvas-package"
                    disabled={disabled} onPress={() => setDialog('package')}>
                    <Ionicons name="archive-outline" size={16} color={secondary} />
                    <Text numberOfLines={1} style={styles.viewportText}>{t('projectCanvas.assetPackage')}</Text>
                </Button>}
            </View>
            {canAddResult && <Button variant="row" label={t('projectCanvas.addResult')} testID="project-canvas-add-result" disabled={disabled} onPress={onAddResult}>
                <Ionicons name="add-circle-outline" size={17} color={theme.colors.textLink} />
                <Text numberOfLines={2} style={styles.actionText}>{t('projectCanvas.addResult')}</Text>
            </Button>}
            <View style={styles.viewportTools}>
                <View style={styles.fit}>
                    <Button variant="toolbar" label={t('projectCanvas.fit')} testID="project-canvas-fit" disabled={disabled} onPress={onFit}>
                        <Ionicons name="scan-outline" size={16} color={secondary} />
                        <Text numberOfLines={1} style={styles.viewportText}>{t('projectCanvas.fit')}</Text>
                    </Button>
                </View>
                <Button variant="toolbar" label={t('projectCanvas.zoomOut')} tooltip={t('projectCanvas.zoomOut')} testID="project-canvas-zoom-out"
                    disabled={disabled} onPress={() => onZoom('out')}>
                    <Ionicons name="remove-outline" size={18} color={secondary} />
                </Button>
                <Button variant="toolbar" label={t('projectCanvas.zoomIn')} tooltip={t('projectCanvas.zoomIn')} testID="project-canvas-zoom-in"
                    disabled={disabled} onPress={() => onZoom('in')}>
                    <Ionicons name="add-outline" size={18} color={secondary} />
                </Button>
            </View>
        </View>
        {dialog && <ProjectCanvasAssetDialog key={dialog} mode={dialog} assets={selected}
            categories={categories} canExportAll={assets.length > 0} onClose={closeDialog}
            onMutation={onMutation} onImportPackage={onImportPackage} onExportPackage={onExportPackage} />}
    </View>;
}

function CanvasToolRow({ asset, size, selected, selecting, category, disabled, onPress }: {
    asset: CanvasToolAsset;
    size: string;
    selected: boolean;
    selecting: boolean;
    category?: string;
    disabled?: boolean;
    onPress(): void;
}) {
    const { theme } = useUnistyles();
    const [failedUri, setFailedUri] = React.useState<string>();
    const format = asset.mimeType === 'image/jpeg' ? 'JPG' : asset.mimeType.split('/').at(-1)?.toUpperCase();
    return <Button variant="row" label={asset.name} testID={`project-canvas-tools-asset-${asset.id}`} selected={selected} disabled={disabled} onPress={onPress}>
        {selecting && <Ionicons name={selected ? 'checkbox-outline' : 'square-outline'} size={17}
            color={selected ? theme.colors.textLink : theme.colors.textSecondary} />}
        <View style={styles.thumbnail}>
            {asset.uri && asset.uri !== failedUri ? <img src={asset.uri} alt="" loading="lazy" decoding="async" draggable={false}
                onError={() => setFailedUri(asset.uri)} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
                : <Ionicons name="image-outline" size={17} color={theme.colors.textSecondary} />}
        </View>
        <View style={styles.assetDetails}>
            <Text style={styles.assetName} numberOfLines={1}>{asset.name}</Text>
            <Text style={styles.assetMeta} numberOfLines={1}>{[format, size, category].filter(Boolean).join(' · ')}</Text>
        </View>
    </Button>;
}

const styles = StyleSheet.create(theme => ({
    panel: {
        flex: 1, minHeight: 0, minWidth: 0, borderRadius: 13,
        borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
    },
    header: {
        flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 46, paddingHorizontal: 12,
        borderBottomWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider,
    },
    title: { minWidth: 0, flexShrink: 1, fontSize: 13, color: theme.colors.text, ...Typography.header() },
    headerSpace: { flex: 1 },
    tabs: {
        flexDirection: 'row', alignItems: 'center', minHeight: 44, gap: 8, paddingHorizontal: 9,
        borderBottomWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider,
    },
    assetsTitle: { flexGrow: 1, paddingHorizontal: 4 },
    count: { alignItems: 'center', minWidth: 22, borderRadius: 9, paddingHorizontal: 4, paddingVertical: 2, backgroundColor: theme.colors.surfaceHigh },
    countText: { fontSize: 11, color: theme.colors.textSecondary, fontVariant: ['tabular-nums'], ...Typography.default('semiBold') },
    body: { flex: 1, minHeight: 0, minWidth: 0 },
    management: { paddingHorizontal: 8, paddingVertical: 4, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider },
    filterRow: { flexDirection: 'row', alignItems: 'center', gap: 2, minWidth: 0 },
    selection: { marginTop: 3, minWidth: 0 },
    selectionStatus: { flexDirection: 'row', alignItems: 'center', gap: 4, minWidth: 0 },
    selectionCount: { flex: 1, minWidth: 0, fontSize: 12, lineHeight: 17, color: theme.colors.textSecondary, ...Typography.default() },
    selectionActions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 2 },
    importActions: { flexDirection: 'row', alignItems: 'center', minWidth: 0, gap: 3 },
    importPrimary: { flex: 1, minWidth: 0 },

    hidden: { display: 'none' },
    list: { paddingHorizontal: 6, paddingVertical: 6, gap: 3 },
    thumbnail: {
        width: 43, height: 36, flexShrink: 0, borderRadius: 6, alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
        borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider, backgroundColor: theme.colors.surfaceHigh,
    },
    assetDetails: { flex: 1, minWidth: 0, gap: 1, alignSelf: 'center' },
    assetName: { fontSize: 12, lineHeight: 17, color: theme.colors.text, ...Typography.default('semiBold') },
    assetMeta: { fontSize: 11, lineHeight: 15, color: theme.colors.textSecondary, ...Typography.default() },
    empty: { paddingHorizontal: 13, paddingVertical: 16, gap: 5 },
    emptyIcon: { width: 38, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 9, backgroundColor: theme.colors.surfaceHigh, marginBottom: 4 },
    emptyText: { fontSize: 12, lineHeight: 17, color: theme.colors.textSecondary, ...Typography.default() },
    footer: { padding: 8, gap: 6, borderTopWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider },
    actionText: { minWidth: 0, flexShrink: 1, fontSize: 12, lineHeight: 17, color: theme.colors.text, ...Typography.default('semiBold') },
    viewportTools: { flexDirection: 'row', alignItems: 'center', gap: 2, marginTop: 1 },
    fit: { flex: 1, minWidth: 0 },
    viewportText: { minWidth: 0, flexShrink: 1, fontSize: 12, color: theme.colors.textSecondary, ...Typography.default() },
}));
