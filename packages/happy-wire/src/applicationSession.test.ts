import { describe, it, expect } from 'vitest';
import { ApplicationSessionMetadataSchema, isApplicationSession } from './applicationSession';
describe('application session provenance', () => {
 it('accepts only explicit valid source metadata', () => {
  expect(isApplicationSession({application:{appId:'advisor',bindingId:'binding'}})).toBe(true);
  for (const metadata of [null, {}, {path:'/apps/advisor'}, {application:{appId:' ',bindingId:'b'}}, {application:{appId:'a',bindingId:''}}]) expect(isApplicationSession(metadata)).toBe(false);
  expect(ApplicationSessionMetadataSchema.safeParse({appId:'a',bindingId:'b',secret:'no'}).success).toBe(false);
 });
});
