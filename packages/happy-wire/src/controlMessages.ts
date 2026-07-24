const TASK_NOTIFICATION_OPEN = '<task-notification>';
const TASK_NOTIFICATION_CLOSE = '</task-notification>';

function leadingTaskNotificationEnd(text: string): number | null {
  if (!text.startsWith(TASK_NOTIFICATION_OPEN)) {
    return null;
  }

  let depth = 1;
  let cursor = TASK_NOTIFICATION_OPEN.length;

  while (depth > 0) {
    const nextOpen = text.indexOf(TASK_NOTIFICATION_OPEN, cursor);
    const nextClose = text.indexOf(TASK_NOTIFICATION_CLOSE, cursor);

    if (nextClose === -1) {
      return null;
    }

    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth += 1;
      cursor = nextOpen + TASK_NOTIFICATION_OPEN.length;
      continue;
    }

    depth -= 1;
    cursor = nextClose + TASK_NOTIFICATION_CLOSE.length;
  }

  return cursor;
}

/**
 * Removes complete leading background-task control envelopes while preserving
 * any real message text that follows them. Incomplete or user-authored inline
 * tag examples are left untouched.
 */
export function stripLeadingTaskNotificationWrappers(text: string): string {
  let remainder = text.trimStart();
  let stripped = false;

  while (remainder.startsWith(TASK_NOTIFICATION_OPEN)) {
    const wrapperEnd = leadingTaskNotificationEnd(remainder);
    if (wrapperEnd === null) {
      break;
    }
    stripped = true;
    remainder = remainder.slice(wrapperEnd).trimStart();
  }

  return stripped ? remainder : text;
}
