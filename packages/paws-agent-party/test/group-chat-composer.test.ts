import { describe, expect, it } from 'vitest';
import { completeMention } from '../src/group-chat/composer.js';

describe('inline mention selection', () => {
  it('replaces the typed @ trigger with one complete mention', () => {
    expect(completeMention('@', '产品顾问')).toBe('@产品顾问 ');
    expect(completeMention('@产品顾问 请和 @技术', '技术顾问')).toBe('@产品顾问 请和 @技术顾问 ');
  });
  it('keeps the existing message when inserting a new mention', () => {
    expect(completeMention('请看一下', '技术顾问')).toBe('请看一下 @技术顾问 ');
  });
});
