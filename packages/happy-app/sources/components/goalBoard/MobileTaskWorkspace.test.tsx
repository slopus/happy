import * as React from 'react';
import { act } from 'react';
// @ts-expect-error react-test-renderer has no declarations.
import TestRenderer from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
vi.mock('react-native', () => ({ View: 'View', Platform: { OS: 'android' } }));
import { MobileTaskWorkspace } from './MobileTaskWorkspace';

it('preserves the conversation instance and its draft through every auxiliary surface', () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const mounted = vi.fn(), unmounted = vi.fn();
    function Conversation() {
        const [draft, setDraft] = React.useState('');
        React.useEffect(() => { mounted(); return unmounted; }, []);
        return <input value={draft} onChange={event => setDraft(event.target.value)} />;
    }
    const render = (view: 'chat' | 'details' | 'files' | 'reader') => <MobileTaskWorkspace view={view} chat={<Conversation />} details={<div>Details</div>} files={<div>Files</div>} reader={<div>Reader</div>} />;
    let r: any; act(() => { r = TestRenderer.create(render('chat')); });
    const original = r.root.findByType(Conversation);
    act(() => r.root.findByType('input').props.onChange({ target: { value: 'Keep this draft' } }));
    for (const view of ['details', 'files', 'reader', 'files', 'chat'] as const) {
        act(() => r.update(render(view)));
        expect(r.root.findByType(Conversation)).toBe(original);
        expect(r.root.findByType('input').props.value).toBe('Keep this draft');
        expect(unmounted).not.toHaveBeenCalled();
    }
    expect(mounted).toHaveBeenCalledTimes(1);
    act(() => r.unmount());
});
