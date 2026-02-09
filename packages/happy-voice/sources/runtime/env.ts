import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config({ path: process.env.HAPPY_VOICE_ENV_FILE || '.env.local' });

const envSchema = z.object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().default('0.0.0.0'),
    PORT: z.coerce.number().int().positive().default(3040),

    VOICE_PUBLIC_KEY: z.string().min(1, 'VOICE_PUBLIC_KEY is required'),

    LIVEKIT_URL: z.string().min(1, 'LIVEKIT_URL is required'),
    LIVEKIT_WS_URL: z.string().optional(),
    LIVEKIT_API_KEY: z.string().min(1, 'LIVEKIT_API_KEY is required'),
    LIVEKIT_API_SECRET: z.string().min(1, 'LIVEKIT_API_SECRET is required'),
    LIVEKIT_AGENT_NAME: z.string().default('happy-voice-agent'),
    LIVEKIT_ROOM_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
    LIVEKIT_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(600),

    AGENT_STT: z.string().default('openai/gpt-4o-mini-transcribe:zh'),
    AGENT_LLM: z.string().default('openai/gpt-4.1-mini'),
    AGENT_TTS: z.string().default('cartesia/sonic-3:9626c31c-bec5-4cca-baa8-f8ba9e84c8bc'),
    AGENT_WELCOME_MESSAGE: z.string().default('Say hello and ask what the user wants to build.'),
    AGENT_READY_PLAYOUT_MODE: z.enum(['best_effort', 'strict']).default('best_effort'),
    AGENT_READY_SUMMARY_MODEL: z.string().optional(),
    AGENT_READY_SUMMARY_TIMEOUT_MS: z.coerce.number().int().positive().default(7000),
    AGENT_READY_SUMMARY_INPUT_MAX_CHARS: z.coerce.number().int().positive().default(2200),
    AGENT_MIN_ENDPOINTING_DELAY_MS: z.coerce.number().int().positive().default(1600),
    AGENT_MAX_ENDPOINTING_DELAY_MS: z.coerce.number().int().positive().default(7000),
    AGENT_LOG_LLM_IO: z.string().default('true'),

    // Prompt templates (support docker volume overrides)
    PROMPT_VOICE_MAIN_FILE: z.string().default('prompts/voice-main.system.txt'),
    PROMPT_VOICE_TOOL_FOLLOWUP_FILE: z.string().default('prompts/voice-tool-followup.system.txt'),
    PROMPT_VOICE_READY_SUMMARY_FILE: z.string().default('prompts/voice-ready-summary.system.txt'),
    PROMPT_RECENT_VOICE_MESSAGES: z.coerce.number().int().positive().default(12),
    PROMPT_RECENT_APP_CONTEXT_MESSAGES: z.coerce.number().int().positive().default(12),
    PROMPT_RECENT_MAX_CHARS: z.coerce.number().int().positive().default(6000),

    TOOL_BRIDGE_BASE_URL: z.string().optional(),
    TOOL_BRIDGE_API_KEY: z.string().optional(),
    TOOL_BRIDGE_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
    console.error('Invalid environment for happy-voice');
    console.error(parsed.error.flatten().fieldErrors);
    throw new Error('Invalid environment for happy-voice');
}

export const env = parsed.data;
