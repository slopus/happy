import { expect, it } from 'vitest';
import { projectLocationHref, restoreProjectLocation } from './projectReturnLocation';

it('round-trips the machine, project, feature, task and selected conversation', () => {
    const location = { machine: 'mac', project: '/目标/创意网页', feature: '/目标/创意网页/features/Design OPS', task: 'task-4', conversation: 'chat-4', author: 'author', view: 'reader', file: '/目标/说明 #1.md' };
    const href = projectLocationHref(location);
    const url = new URL(href, 'https://paws.invalid');
    expect(Object.fromEntries(url.searchParams)).toEqual(location);
    expect(restoreProjectLocation(href)).toBe(href);
});
it('clearing child parameters records the deliberately selected parent instead of reviving them', () => {
    const href = projectLocationHref({ machine: 'mac', project: undefined, feature: undefined, task: undefined, conversation: undefined });
    expect(href).toBe('/projects?machine=mac');
    expect(projectLocationHref({})).toBe('/projects');
});
it('does not retain unrelated query data, fragments, arrays or malformed values', () => {
    expect(projectLocationHref({ machine: 'mac', task: ['one', 'two'], feature: '', token: 'synthetic', file: 'x'.repeat(8193) })).toBe('/projects?machine=mac');
    expect(restoreProjectLocation('/projects?machine=mac&debug=synthetic#fragment')).toBe('/projects?machine=mac');
});
it.each([null, undefined, [], '/settings', '/projects-other?task=one', 'https://other.test/projects?task=one', '//other.test/projects', 'x'.repeat(65537)])('fails closed for an invalid saved destination: %s', value => {
    expect(restoreProjectLocation(value)).toBe('/projects');
});
