import * as React from 'react';
import { act } from 'react';
// @ts-expect-error react-test-renderer has no declarations.
import TestRenderer from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GoalProjectCanvasChange } from '@slopus/happy-wire';
import type { ProjectCanvasToolsProps } from './ProjectCanvasTools.web';

vi.mock('react-native', () => ({
    Modal: 'Modal', ScrollView: 'ScrollView', Text: 'Text', TextInput: 'TextInput', View: 'View',
    useWindowDimensions: () => ({ width: 320, height: 700 }),
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'e429bb58-3f05-4f17-9ba0-0e84e22edc5b' }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Icon' }));
vi.mock('react-native-unistyles', () => {
    const theme = {
        colors: { text: 'text', textLink: 'link', textSecondary: 'secondary', textDestructive: 'error', divider: 'divider',
            modal: { backdrop: 'backdrop' }, shadow: { color: 'shadow' } },
    };
    return { StyleSheet: { create: (make: (theme: object) => object) => make(theme), hairlineWidth: 1 }, useUnistyles: () => ({ theme }) };
});
vi.mock('@/components/PanelTabs', () => ({ PanelTabs: 'Tabs' }));
vi.mock('@/components/WebModalBackdrop', () => ({ WebModalBackdrop: 'Backdrop' }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}), header: () => ({}) } }));
vi.mock('@/hooks/useProjectModalEscape', () => ({ useProjectModalEscape: () => {} }));
vi.mock('@/text', () => ({ getCurrentLanguage: () => 'en', t: (key: string) => key }));
vi.mock('./GoalBoardButton', () => ({ GoalBoardButton: 'Button' }));

import { ProjectCanvasTools } from './ProjectCanvasTools.web';

const image = { mimeType: 'image/png', size: 690 };
const assets = [
    { ...image, id: 'draft-1', name: 'Draft 1.png', categoryId: 'draft', x: 82, y: 10 },
    { ...image, id: 'draft-2', name: 'Draft 2.png', categoryId: 'draft', x: 31, y: 108 },
    { ...image, id: 'reference', name: 'Reference.png', x: 200, y: 108 },
];
const categories = [{ id: 'draft', name: 'Drafts' }, { id: 'final', name: 'Final' }];
const noop = () => {};
let renderer: ReturnType<typeof TestRenderer.create> | undefined;
const mutation = vi.fn<(changes: readonly GoalProjectCanvasChange[]) => Promise<void>>();
const onExportPackage = vi.fn<(ids?: readonly string[]) => Promise<void>>();

function render(overrides: Partial<ProjectCanvasToolsProps> = {}) {
    const props: ProjectCanvasToolsProps = {
        assets, categories, previewVisible: true, onPreviewAsset: noop, onImport: noop, onAddResult: noop,
        onFocusAsset: noop, onFit: noop, onZoom: noop, onMutation: mutation, onExportPackage,
        ...overrides,
    };
    act(() => { renderer = TestRenderer.create(<ProjectCanvasTools {...props} />); });
}
function button(id: string) {
    return renderer!.root.findByProps({ testID: id });
}
async function press(id: string) {
    await act(async () => { button(id).props.onPress(); });
}
function field(id: string, value: string) {
    act(() => button(id).props.onChangeText(value));
}
beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    mutation.mockReset().mockResolvedValue();
    onExportPackage.mockReset().mockResolvedValue();
});
afterEach(() => act(() => { renderer?.unmount(); renderer = undefined; }));

describe('project canvas manual tools', () => {
    it('reports the category filter without including hidden assets in select-all', async () => {
        const onCategoryFilterChange = vi.fn();
        render({ categoryFilter: 'draft', onCategoryFilterChange });
        const filter = renderer!.root.findByProps({ 'data-testid': 'project-canvas-category-filter' });
        expect(filter.props.value).toBe('draft');
        act(() => filter.props.onChange({ currentTarget: { value: '@uncategorized' } }));
        expect(onCategoryFilterChange).toHaveBeenCalledOnce();
        expect(onCategoryFilterChange).toHaveBeenCalledWith(null);
        expect(renderer!.root.findAllByProps({ testID: 'project-canvas-tools-asset-reference' })).toHaveLength(0);
        await press('project-canvas-selection-toggle');
        await press('project-canvas-select-visible');
        await press('project-canvas-batch-categorize');
        await press('project-canvas-assign-final');
        expect(mutation).toHaveBeenCalledExactlyOnceWith([
            { type: 'update-asset', assetId: 'draft-1', categoryId: 'final' },
            { type: 'update-asset', assetId: 'draft-2', categoryId: 'final' },
        ]);
    });

    it('retains edited names on backdrop click and issues explicit category and image renames', async () => {
        render({ activeAssetId: 'draft-1' });
        await press('project-canvas-manage-categories');
        await press('project-canvas-category-create');
        field('project-canvas-category-name', 'Research / References');
        act(() => button('project-canvas-manage-backdrop').props.onClose());
        expect(button('project-canvas-category-name').props.value).toBe('Research / References');
        await press('project-canvas-category-save');
        expect(mutation).toHaveBeenLastCalledWith([{ type: 'upsert-category', id: 'category-e429bb58-3f05-4f17-9ba0-0e84e22edc5b', name: 'Research / References' }]);
        await press('project-canvas-category-rename-draft');
        field('project-canvas-category-name', 'Candidates');
        await press('project-canvas-category-save');
        expect(mutation).toHaveBeenLastCalledWith([{ type: 'upsert-category', id: 'draft', name: 'Candidates' }]);
        await press('project-canvas-category-delete-final');
        await press('project-canvas-category-delete-confirm');
        expect(mutation).toHaveBeenLastCalledWith([{ type: 'delete-category', id: 'final' }]);
        await press('project-canvas-manage-close');
        await press('project-canvas-selection-toggle');
        await press('project-canvas-batch-rename');
        field('project-canvas-asset-name', 'Revised Draft.png');
        await press('project-canvas-asset-rename-save');
        expect(mutation).toHaveBeenLastCalledWith([{ type: 'update-asset', assetId: 'draft-1', name: 'Revised Draft.png' }]);
    });

    it('translates a canvas multi-selection together and deletes it with one explicit change set', async () => {
        render({ selectedAssetIds: ['draft-1', 'draft-2'] });
        await press('project-canvas-selection-toggle');
        await press('project-canvas-batch-arrange');
        field('project-canvas-arrange-shift-x', '25');
        field('project-canvas-arrange-shift-y', '-5');
        await press('project-canvas-arrange-shift');
        expect(mutation).toHaveBeenLastCalledWith([
            { type: 'update-asset', assetId: 'draft-1', x: 107, y: 5 },
            { type: 'update-asset', assetId: 'draft-2', x: 56, y: 103 },
        ]);
        await press('project-canvas-batch-delete');
        expect(mutation).toHaveBeenCalledTimes(1);
        await press('project-canvas-delete-confirm');
        expect(mutation).toHaveBeenLastCalledWith([
            { type: 'remove-asset', assetId: 'draft-1' }, { type: 'remove-asset', assetId: 'draft-2' },
        ]);
    });

    it('offers both project and selected asset packages and delegates import to the file picker', async () => {
        const onImportPackage = vi.fn();
        render({ activeAssetId: 'reference', onImportPackage });
        await press('project-canvas-selection-toggle');
        await press('project-canvas-package');
        await press('project-canvas-package-export-selected');
        expect(onExportPackage).toHaveBeenLastCalledWith(['reference']);
        await press('project-canvas-package');
        await press('project-canvas-package-export-all');
        expect(onExportPackage).toHaveBeenLastCalledWith();
        await press('project-canvas-package');
        await press('project-canvas-package-import');
        expect(onImportPackage).toHaveBeenCalledOnce();
    });
});
