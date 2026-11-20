import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ComposerAgentAction, getComposerAgentActionStyle } from './ComposerAgentAction.web';
describe('branded Web new-session action', () => {
 it('uses an accessible brand action and keeps both reversible animation layers mounted', () => { const html=renderToStaticMarkup(<ComposerAgentAction agent="claude" label="新建会话" fallback={<span>arrow</span>}/>);expect(html).toContain('新建会话');expect(html).toContain('arrow');expect(html).toContain('#201A17');expect(html).toContain('prefers-reduced-motion'); });
 it('restores ordinary theme styles while preserving the reversible width transition', () => { expect(getComposerAgentActionStyle(null)).toMatchObject({ width:32,borderRadius:16 });expect(getComposerAgentActionStyle('claude')).toMatchObject({ width:110,backgroundColor:'#D97757' });expect(getComposerAgentActionStyle('codex')).toMatchObject({ backgroundColor:'#3941FF' });expect(getComposerAgentActionStyle('opencode')).toMatchObject({ backgroundColor:'#59616B' });expect(getComposerAgentActionStyle(undefined)).toBeUndefined(); });
});
