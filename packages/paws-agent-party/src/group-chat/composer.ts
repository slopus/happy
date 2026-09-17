/** Finish the @ token the user is typing, preserving the preceding message. */
export function completeMention(text: string, name: string): string {
  if (/@[^\s@]*$/u.test(text)) return text.replace(/@[^\s@]*$/u, `@${name} `);
  return `${text}${text && !text.endsWith(' ') ? ' ' : ''}@${name} `;
}
