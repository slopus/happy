import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error react-test-renderer does not publish declarations.
import TestRenderer from 'react-test-renderer';
import { RoleModelPicker } from './RoleModelPicker';
import { SearchableListSelector, type SelectorConfig } from '@/components/SearchableListSelector';

vi.mock('react-native', () => ({
    View: 'View', Text: 'Text', Pressable: 'Pressable', ScrollView: 'ScrollView',
    Platform: { OS: 'web', select: (value: any) => value.web ?? value.default },
    useWindowDimensions: () => ({ width: 800, height: 900 }),
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('react-native-unistyles', () => {
    const theme = { colors: { surface: 'surface', divider: 'divider', text: 'text', textSecondary: 'secondary', input: { background: 'input' }, button: { primary: { background: 'primary', tint: 'tint' } } } };
    return { StyleSheet: { create: (factory: any) => factory(theme) }, useUnistyles: () => ({ theme }) };
});
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/components/Item', () => ({ Item: 'Item' }));
vi.mock('@/components/ItemGroup', () => ({ ItemGroup: 'ItemGroup' }));
vi.mock('@/components/MultiTextInput', () => ({ MultiTextInput: 'MultiTextInput' }));
vi.mock('@/components/StatusDot', () => ({ StatusDot: 'StatusDot' }));
vi.mock('@/modal', () => ({ Modal: { alert: vi.fn() } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));

const models = [
    { code: 'gpt-6.1-sol', value: 'GPT 6.1 Sol' },
    { code: 'neon', value: 'Neon Writer' },
    { code: 'gemini-3-pro', value: 'Gemini 3 Pro' },
];

describe('role model catalog search', () => {
    let renderer: any;
    const onSelect = vi.fn(), onClose = vi.fn(), onDismiss = vi.fn();
    const titles = () => renderer.root.findAllByType('Item').map((node: any) => node.props.title);
    const search = (query: string) => act(() => renderer.root.findByType('MultiTextInput').props.onChangeText(query));
    beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; vi.clearAllMocks(); });
    afterEach(() => { if (renderer) act(() => renderer.unmount()); renderer = undefined; });

    it('filters the actual model list by code and label without changing selection, then clears back to all choices', () => {
        act(() => { renderer = TestRenderer.create(<RoleModelPicker models={models} selectedCode="neon" onSelect={onSelect} onClose={onClose} onDismiss={onDismiss} />); });
        const all = ['delegation.nativeDefault', ...models.map(model => model.value)];
        expect(titles()).toEqual(all);
        expect(renderer.root.findByType('MultiTextInput').props.value).toBe('Neon Writer');
        search('  GPT-6.1  ');
        expect(titles()).toEqual(['GPT 6.1 Sol']);
        search('WRITER');
        expect(titles()).toEqual(['Neon Writer']);
        expect(renderer.root.findByType('Item').props.selected).toBe(true);
        search('not-a-model');
        expect(titles()).toEqual(['projectGoals.noMatchingItems']);
        expect(onSelect).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled();
        const clear = renderer.root.findAllByType('Pressable').find((node: any) => node.findAllByProps({ name: 'close' }).length === 1);
        act(() => clear.props.onPress());
        expect(renderer.root.findByType('MultiTextInput').props.value).toBe('');
        expect(titles()).toEqual(all);
        expect(renderer.root.findAllByType('Item').filter((node: any) => node.props.selected).map((node: any) => node.props.title)).toEqual(['Neon Writer']);
        expect(onSelect).not.toHaveBeenCalled();
        search('gemini-3');
        act(() => renderer.root.findByType('Item').props.onPress());
        expect(onSelect).toHaveBeenCalledExactlyOnceWith('gemini-3-pro'); expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('keeps other full-catalog consumers unchanged unless they opt in', () => {
        const config: SelectorConfig<typeof models[number]> = {
            getItemId: option => option.code, getItemTitle: option => option.value, getItemIcon: () => null,
            formatForDisplay: option => option.value, parseFromDisplay: () => null,
            filterItem: (option, query) => option.code.includes(query),
            searchPlaceholder: 'Search', recentSectionTitle: 'Models', favoritesSectionTitle: '', noItemsMessage: 'No models',
            showRecent: false, showFavorites: false, allowCustomInput: false,
        };
        act(() => { renderer = TestRenderer.create(<SearchableListSelector config={config} items={models} selectedItem={models[1]} onSelect={onSelect} />); });
        search('not-a-model');
        expect(titles()).toEqual(models.map(model => model.value));
        expect(onSelect).not.toHaveBeenCalled();
    });
});
