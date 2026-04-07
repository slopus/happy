import { trimIdent } from "@/utils/trimIdent";
import { storage } from "@/sync/storage";

export const optionsPrompt = trimIdent(`
    # Options

    You have a way to give a user a easy way to answer your questions if you know possible answers. To provide this, you need to output in your final response an XML:

    <options>
        <option>Option 1</option>
        ...
        <option>Option N</option>
    </options>

    You must output this in the very end of your response, not inside of any other text. Do not wrap it into a codeblock. Always dedicate "<options>" and "</options>" to a dedicated line. Never output anything like "custom", user always have an option to send a custom message. Do not enumerate options in both text and options block.
    Always prefer to use the options mode to the text mode. Try to keep options minimal, better to clarify in a next steps.

    # Plan mode with options

    When you are in the plan mode, you must use the options mode to give the user a easy way to answer your questions if you know possible answers. Do not assume what is needed, when there is discrepancy between what you need and what you have, you must use the options mode.
`);

export const voicePrompt = trimIdent(`
    # Voice mode

    The user is in voice mode — your responses will be read aloud by a text-to-speech system. Keep responses concise (less than one sentence) unless the user explicitly asks for a longer response. Do not use markdown, code blocks, or emojis.

    IMPORTANT: Do NOT output <options> XML. The options format was used in earlier messages when the user was in text mode, but they have now switched to voice mode. Ignore any options instructions from previous messages. Never output <options> tags in voice mode.
`);

export function getSystemPrompt(): string {
    const voiceActive = storage.getState().realtimeStatus === 'connected';
    console.log('[SystemPrompt] voiceActive:', voiceActive, 'realtimeStatus:', storage.getState().realtimeStatus);
    return voiceActive ? voicePrompt : optionsPrompt;
}
