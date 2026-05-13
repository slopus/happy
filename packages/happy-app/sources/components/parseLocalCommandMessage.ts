/**
 * Parses Claude Agent SDK's local-slash-command wrapper messages.
 *
 * When a `/foo` command runs, the SDK injects synthetic user messages whose
 * content is XML-like tags such as:
 *   <local-command-caveat>...</local-command-caveat>
 *   <command-message>foo</command-message><command-name>/foo</command-name>
 *
 * Rendered through markdown unchanged they look like raw HTML in the chat.
 * We strip / collapse them into structured intents the renderer can show
 * (or hide) cleanly.
 */

export type LocalCommandMessage =
    | { kind: 'caveat' }
    | { kind: 'command-run'; commandName: string }
    | { kind: 'text'; text: string };

const CAVEAT_RE = /^\s*<local-command-caveat>[\s\S]*?<\/local-command-caveat>\s*$/;
const COMMAND_NAME_RE = /<command-name>\s*\/?([^<]+?)\s*<\/command-name>/;
const COMMAND_MESSAGE_RE = /<command-message>[\s\S]*?<\/command-message>/g;
const COMMAND_NAME_TAG_RE = /<command-name>[\s\S]*?<\/command-name>/g;

export function parseLocalCommandMessage(text: string): LocalCommandMessage {
    if (CAVEAT_RE.test(text)) {
        return { kind: 'caveat' };
    }

    const nameMatch = text.match(COMMAND_NAME_RE);
    if (nameMatch) {
        // If the message is essentially just the command wrappers (after
        // stripping them out only whitespace remains), collapse to a chip.
        const stripped = text
            .replace(COMMAND_MESSAGE_RE, '')
            .replace(COMMAND_NAME_TAG_RE, '')
            .trim();
        if (stripped.length === 0) {
            return { kind: 'command-run', commandName: nameMatch[1] };
        }
        // Mixed content: keep the surrounding text, drop the tags.
        return { kind: 'text', text: stripped };
    }

    return { kind: 'text', text };
}
