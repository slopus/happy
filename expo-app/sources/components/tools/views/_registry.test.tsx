import { describe, expect, it } from 'vitest';
import { getToolViewComponent } from './_registry';
import { ReadView } from './ReadView';

describe('toolViewRegistry', () => {
    it('registers a Read view for lowercase read tool name', () => {
        expect(getToolViewComponent('read')).toBe(ReadView);
    });
});
