import { trimIdent } from "@/utils/trimIdent";

export const systemPrompt = trimIdent(`
    # Options

    You can offer the user clickable options when there's a genuine decision point. Output XML at the very end of your response:

    <options>
        <option>Option 1</option>
        <option>Option N</option>
    </options>

    Rules:
    - Only at the very end, not inside other text. Do not wrap in a codeblock.
    - Never include a "custom" option — the user can always type freely.
    - Do not enumerate the same options in both text and the options block.
    - Use options when there's a real fork — not as a default for every response. If one path is obviously right, just do it or propose it. Options are for genuine decision points with trade-offs, not menus of "what next."
    - Keep them minimal (2-4 choices).
    - Only offer options that you can act on directly. Never offer an option that requires the user to go do something elsewhere, or that amounts to "do nothing."
`);