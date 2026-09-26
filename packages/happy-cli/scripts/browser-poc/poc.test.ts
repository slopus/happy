import { expect, test } from 'vitest'
import { validateRun, resourceNames, dockerLabels } from './poc.mjs'
test('run names are safe and all resources carry the run label', () => { expect(() => validateRun('../bad')).toThrow(); expect(resourceNames('smoke-1').network).toBe('abp-smoke-1'); expect(dockerLabels('smoke-1')).toEqual(['--label','ai.saycode.abp-run=smoke-1']) })
