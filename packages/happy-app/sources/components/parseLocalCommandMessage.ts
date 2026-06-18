/**
 * Parses Claude Agent SDK's local-slash-command wrapper messages.
 *
 * When a `/foo` command runs, the SDK injects synthetic user messages whose
 * content is XML-like tags such as:
 *   <local-command-caveat>...</local-command-caveat>
 *   <command-message>foo</command-message><command-name>/foo</command-name>
 *   <command-message>foo</command-message><command-name>/foo</command-name><command-args>the args</command-args>
 *
 * Rendered through markdown unchanged they look like raw HTML in the chat —
 * and because the old parser only stripped <command-message>/<command-name>,
 * any command WITH arguments left a non-empty <command-args> tag behind, so
 * it fell through to plain text instead of collapsing to a chip (looked like
 * the user's message duplicated, and the "command ran" chip never showed).
 *
 * We strip / collapse them into structured intents the renderer can show
 * (or hide) cleanly, carrying the args out separately so the renderer can
 * display them as the user's actual prompt.
 */

export type LocalCommandMessage =
    | { kind: 'caveat' }
    | { kind: 'command-run'; commandName: string; args?: string }
    | { kind: 'text'; text: string };

const CAVEAT_RE = /^\s*<local-command-caveat>[\s\S]*?<\/local-command-caveat>\s*$/;
const COMMAND_NAME_RE = /<command-name>\s*\/?([^<]+?)\s*<\/command-name>/;
const COMMAND_ARGS_RE = /<command-args>\s*([\s\S]*?)\s*<\/command-args>/;
// Greedy on purpose: skill bodies often contain literal `<command-message>`
// examples in their markdown, producing nested closing tags inside the SDK
// wrapper. A lazy match stops at the inner closer and leaves the outer tail
// behind, which then falls through to `kind: 'text'` and renders the whole
// skill body as plain text in the chat.
const COMMAND_MESSAGE_RE = /<command-message>[\s\S]*<\/command-message>/g;
const COMMAND_NAME_TAG_RE = /<command-name>[\s\S]*?<\/command-name>/g;
const COMMAND_ARGS_TAG_RE = /<command-args>[\s\S]*?<\/command-args>/g;

export function parseLocalCommandMessage(text: string): LocalCommandMessage {
    if (CAVEAT_RE.test(text)) {
        return { kind: 'caveat' };
    }

    // Strip <command-message> blocks first so any nested <command-name> /
    // <command-args> examples in a skill body don't get picked up by the
    // extractors below — only the outer wrapper's tags should be visible.
    const withoutMessageBlocks = text.replace(COMMAND_MESSAGE_RE, '');

    const nameMatch = withoutMessageBlocks.match(COMMAND_NAME_RE);
    if (nameMatch) {
        const argsMatch = withoutMessageBlocks.match(COMMAND_ARGS_RE);
        const args = argsMatch?.[1].trim();

        // If the message is just the command wrappers (after stripping all of
        // them only whitespace remains), collapse to a chip. The args, if any,
        // are surfaced separately so the renderer can show them as the user's
        // actual prompt rather than as raw XML.
        const stripped = withoutMessageBlocks
            .replace(COMMAND_NAME_TAG_RE, '')
            .replace(COMMAND_ARGS_TAG_RE, '')
            .trim();
        if (stripped.length === 0) {
            return {
                kind: 'command-run',
                commandName: nameMatch[1],
                args: args && args.length > 0 ? args : undefined,
            };
        }
        // Mixed content: keep the surrounding text, drop the tags.
        return { kind: 'text', text: stripped };
    }

    return { kind: 'text', text };
}

// A pure slash-command invocation: starts with `/`, a command token
// (letters, digits, `:`, `-`, `_`), optionally followed by whitespace +
// args. Deliberately strict so paths like `/etc/hosts` or a lone `/`
// do NOT match.
const SLASH_COMMAND_RE = /^\/[a-zA-Z][\w:-]*(?:\s[\s\S]*)?$/;

/**
 * True when this user-text message is the user's OWN echoed slash-command
 * input (e.g. `/superpowers:brainstorming do the thing`) that the Claude
 * Agent SDK will re-emit as a `<command-message>/<command-name>` wrapper.
 *
 * Happy shows the user's sent message optimistically (it carries a
 * `localId`); the SDK then injects the canonical wrapper (no `localId`,
 * rendered as a chip). Showing both looks like a duplicate, so we hide
 * the raw echo and let the wrapper chip stand in — matching how the
 * Claude Code terminal renders slash commands.
 *
 * Gated on `hasLocalId` so we only ever hide a message the user actually
 * sent from Happy, never an agent/SDK-originated one.
 */
export function isUserSlashCommandEcho(text: string, hasLocalId: boolean): boolean {
    if (!hasLocalId) {
        return false;
    }
    const trimmed = text.trim();
    if (!SLASH_COMMAND_RE.test(trimmed)) {
        return false;
    }
    // Guard: a real wrapper message also contains <command-name>; never
    // treat that as a raw echo.
    return parseLocalCommandMessage(trimmed).kind === 'text';
}
