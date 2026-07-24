import { describe, expect, it } from 'vitest';
import { stripLeadingTaskNotificationWrappers } from './controlMessages';

const notification = `<task-notification>
<task-id>agent-123</task-id>
<status>completed</status>
<summary>Background agent completed</summary>
<result>Useful but already-rendered result</result>
<usage><subagent_tokens>29207</subagent_tokens><tool_uses>14</tool_uses></usage>
</task-notification>`;

describe('stripLeadingTaskNotificationWrappers', () => {
  it('removes a control-only task notification', () => {
    expect(stripLeadingTaskNotificationWrappers(notification)).toBe('');
  });

  it('preserves visible text following one or more notifications', () => {
    expect(stripLeadingTaskNotificationWrappers(`${notification}\n${notification}\nContinue with the fix`))
      .toBe('Continue with the fix');
  });

  it('handles nested task notification tags', () => {
    const nested = `<task-notification>outer ${notification}</task-notification>\nVisible`;
    expect(stripLeadingTaskNotificationWrappers(nested)).toBe('Visible');
  });

  it('leaves malformed and inline tag examples untouched', () => {
    const malformed = '<task-notification>unfinished';
    const inline = 'Explain <task-notification> wrappers';

    expect(stripLeadingTaskNotificationWrappers(malformed)).toBe(malformed);
    expect(stripLeadingTaskNotificationWrappers(inline)).toBe(inline);
  });
});
