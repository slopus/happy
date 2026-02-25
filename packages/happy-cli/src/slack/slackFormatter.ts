/**
 * SDK message → Slack mrkdwn formatter
 *
 * Converts Claude Code SDK messages into Slack-compatible mrkdwn strings.
 * Handles markdown-to-mrkdwn syntax translation, message filtering,
 * and splitting long messages to stay within Slack's size limits.
 */

import type {
    SDKMessage,
    SDKAssistantMessage,
    SDKResultMessage,
} from '@/claude/sdk/types'

/** Slack block text limit (leaving margin from the 3000 char API limit) */
const MAX_SLACK_MESSAGE_LENGTH = 3000

/**
 * Convert GitHub-flavored Markdown to Slack mrkdwn syntax.
 *
 * Conversion rules:
 * - `**bold**` → `*bold*`
 * - `*italic*` (not inside bold) → `_italic_`
 * - Triple-backtick code blocks are preserved (Slack supports them natively)
 * - Inline `code` is preserved (Slack supports single backtick)
 * - Headings `# text` → `*text*` (bolded in Slack)
 * - Links `[text](url)` → `<url|text>`
 *
 * @param text - Markdown text to convert
 * @returns Slack mrkdwn formatted string
 */
export function markdownToMrkdwn(text: string): string {
    const lines = text.split('\n')
    const result: string[] = []
    let inCodeBlock = false

    for (const line of lines) {
        // Track code block boundaries
        if (line.trimStart().startsWith('```')) {
            inCodeBlock = !inCodeBlock
            result.push(line)
            continue
        }

        // Preserve code block contents as-is
        if (inCodeBlock) {
            result.push(line)
            continue
        }

        let converted = line

        // Headings → bold
        converted = converted.replace(/^(#{1,6})\s+(.+)$/, (_match, _hashes: string, content: string) => {
            return `*${content.trim()}*`
        })

        // Links: [text](url) → <url|text>
        converted = converted.replace(
            /\[([^\]]+)\]\(([^)]+)\)/g,
            (_match, linkText: string, url: string) => `<${url}|${linkText}>`,
        )

        // Bold: **text** → *text*  (must run before italic conversion)
        converted = converted.replace(/\*\*(.+?)\*\*/g, '*$1*')

        // Italic: *text* → _text_
        // Match single asterisks that are NOT part of bold markers (already converted above).
        // Use negative lookbehind/lookahead to avoid matching inside **bold** remnants.
        converted = converted.replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, '_$1_')

        // Strikethrough: ~~text~~ → ~text~
        converted = converted.replace(/~~(.+?)~~/g, '~$1~')

        result.push(converted)
    }

    return result.join('\n')
}

/**
 * Determine whether an SDK message should be posted to Slack.
 *
 * Posts only:
 * - Assistant messages that contain text or tool_use blocks
 * - Result messages (session completion summaries)
 *
 * Filters out:
 * - User messages (tool_result echoes, internal prompts)
 * - System messages (session metadata)
 * - Log messages
 *
 * @param message - SDK message to evaluate
 * @returns true if the message should be forwarded to Slack
 */
export function shouldPostToSlack(message: SDKMessage): boolean {
    if (message.type === 'assistant') {
        const assistantMsg = message as SDKAssistantMessage
        const content = assistantMsg.message?.content
        if (!Array.isArray(content) || content.length === 0) {
            return false
        }
        // Post if there is at least one text or tool_use block
        return content.some((block) => block.type === 'text' || block.type === 'tool_use')
    }

    if (message.type === 'result') {
        return true
    }

    return false
}

/**
 * Format an SDK message into one or more Slack mrkdwn strings.
 *
 * For assistant messages, text blocks are concatenated and tool_use blocks are
 * rendered as context lines. For result messages, a completion summary is built.
 *
 * Long messages are split at `MAX_SLACK_MESSAGE_LENGTH` on line boundaries so
 * each string fits within Slack's block text limit.
 *
 * @param message - SDK message to format
 * @returns Array of mrkdwn strings (one per Slack message to send)
 */
export function formatSDKMessageForSlack(message: SDKMessage): string[] {
    if (message.type === 'assistant') {
        return formatAssistantMessage(message as SDKAssistantMessage)
    }

    if (message.type === 'result') {
        return formatResultMessage(message as SDKResultMessage)
    }

    return []
}

/**
 * Format an assistant message: extract text blocks and annotate tool_use blocks.
 */
function formatAssistantMessage(message: SDKAssistantMessage): string[] {
    const parts: string[] = []
    const content = message.message?.content ?? []

    for (const block of content) {
        if (block.type === 'text' && block.text) {
            parts.push(markdownToMrkdwn(block.text))
        } else if (block.type === 'tool_use' && block.name) {
            parts.push(formatToolUse(block.name, block.input))
        }
    }

    if (parts.length === 0) {
        return []
    }

    return splitMessage(parts.join('\n'))
}

/**
 * Format a tool_use block into a compact, informative Slack line.
 *
 * Shows the tool name with a context-specific summary so users can
 * understand what Claude is doing without seeing the full input.
 */
function formatToolUse(name: string, input: unknown): string {
    const inp = input as Record<string, unknown> | undefined
    if (!inp) {
        return `:hammer_and_wrench: *${name}*`
    }

    switch (name) {
        case 'Bash': {
            const cmd = truncate(String(inp.command ?? ''), 200)
            return cmd
                ? `:computer: \`${cmd}\``
                : `:computer: *Bash*`
        }
        case 'Read': {
            const fp = shortPath(String(inp.file_path ?? ''))
            return `:page_facing_up: ${fp}`
        }
        case 'Edit': {
            const fp = shortPath(String(inp.file_path ?? ''))
            return `:pencil2: ${fp}`
        }
        case 'Write': {
            const fp = shortPath(String(inp.file_path ?? ''))
            return `:memo: ${fp}`
        }
        case 'Glob': {
            const pat = String(inp.pattern ?? '')
            return `:mag: \`${pat}\``
        }
        case 'Grep': {
            const pat = String(inp.pattern ?? '')
            return `:mag: grep \`${pat}\``
        }
        case 'WebFetch': {
            const url = truncate(String(inp.url ?? ''), 120)
            return `:globe_with_meridians: ${url}`
        }
        case 'WebSearch': {
            const q = truncate(String(inp.query ?? ''), 120)
            return `:mag_right: ${q}`
        }
        case 'Task': {
            const desc = truncate(String(inp.description ?? ''), 80)
            return `:robot_face: Task: ${desc}`
        }
        default: {
            // MCP tools or unknown — show name with first string value as hint
            const hint = findFirstStringValue(inp)
            return hint
                ? `:hammer_and_wrench: *${name}* — ${truncate(hint, 80)}`
                : `:hammer_and_wrench: *${name}*`
        }
    }
}

/** Shorten an absolute file path to the last 2 segments */
function shortPath(filePath: string): string {
    if (!filePath) return '(unknown)'
    const segments = filePath.split('/')
    if (segments.length <= 2) return `\`${filePath}\``
    return `\`…/${segments.slice(-2).join('/')}\``
}

/** Truncate a string, appending ellipsis if needed */
function truncate(text: string, max: number): string {
    // Replace newlines with spaces for single-line display
    const oneLine = text.replace(/\n/g, ' ')
    if (oneLine.length <= max) return oneLine
    return oneLine.slice(0, max - 1) + '…'
}

/** Find the first short string value in an object (for unknown tools) */
function findFirstStringValue(obj: Record<string, unknown>): string | null {
    for (const val of Object.values(obj)) {
        if (typeof val === 'string' && val.length > 0 && val.length < 200) {
            return val
        }
    }
    return null
}

/**
 * Format a result message with session completion summary.
 */
function formatResultMessage(message: SDKResultMessage): string[] {
    const statusLabel = message.subtype === 'success'
        ? ':white_check_mark: Session completed'
        : `:warning: Session ended (${message.subtype})`

    // Don't include message.result — it duplicates the final assistant message
    // that was already posted to the thread.
    const durationSec = Math.round(message.duration_ms / 1000)
    const costStr = message.total_cost_usd.toFixed(4)

    return [`${statusLabel}\n_${message.num_turns} turns | ${durationSec}s | $${costStr}_`]
}

/**
 * Split a string into chunks that each fit within Slack's message size limit.
 * Splits on newline boundaries to avoid breaking mid-line.
 */
function splitMessage(text: string): string[] {
    if (text.length <= MAX_SLACK_MESSAGE_LENGTH) {
        return [text]
    }

    const chunks: string[] = []
    const lines = text.split('\n')
    let current = ''

    for (const line of lines) {
        // If a single line exceeds the limit, force-split it by character
        if (line.length > MAX_SLACK_MESSAGE_LENGTH) {
            // Flush current buffer first
            if (current.length > 0) {
                chunks.push(current)
                current = ''
            }
            for (let i = 0; i < line.length; i += MAX_SLACK_MESSAGE_LENGTH) {
                chunks.push(line.slice(i, i + MAX_SLACK_MESSAGE_LENGTH))
            }
            continue
        }

        const separator = current.length > 0 ? '\n' : ''
        if (current.length + separator.length + line.length > MAX_SLACK_MESSAGE_LENGTH) {
            chunks.push(current)
            current = line
        } else {
            current += separator + line
        }
    }

    if (current.length > 0) {
        chunks.push(current)
    }

    return chunks
}
