/**
 * API functions for voice assistant integration.
 *
 * Fetches conversation tokens from the server for ElevenLabs integration.
 * The server handles authentication with ElevenLabs API, keeping credentials secure.
 *
 * Supports two modes:
 * 1. Default: Server uses its own ElevenLabs credentials (production)
 * 2. Custom: Client provides their own ElevenLabs agent ID and API key
 */

import { getServerUrl } from '@/sync/serverConfig';
import { getCurrentAuth } from '@/auth/AuthContext';
import { storage } from '@/sync/storage';

export interface VoiceTokenResponse {
    allowed: boolean;
    token?: string;
    agentId?: string;
    error?: string;
}

export interface VoiceTokenRequest {
    revenueCatPublicKey?: string;
    // Custom ElevenLabs credentials (when user provides their own)
    customAgentId?: string;
    customApiKey?: string;
}

/**
 * Fetch a conversation token from the server for ElevenLabs voice sessions.
 *
 * This uses the private agent flow where:
 * 1. Server holds the ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID (or uses user-provided ones)
 * 2. Server fetches a short-lived conversation token from ElevenLabs
 * 3. Client uses this token to establish WebRTC connection
 *
 * If the user has configured custom ElevenLabs credentials in settings,
 * those will be passed to the server to use instead of the default production agent.
 *
 * @returns Object with allowed status, and if allowed, the token and agentId
 * @throws Error if not authenticated or network failure
 */
export async function fetchVoiceToken(): Promise<VoiceTokenResponse> {
    const auth = getCurrentAuth();
    if (!auth?.credentials?.token) {
        throw new Error('Not authenticated');
    }

    // Check if user has custom ElevenLabs credentials configured
    const settings = storage.getState().settings;
    const useCustomAgent = settings.elevenLabsUseCustomAgent;
    const customAgentId = settings.elevenLabsAgentId;
    const customApiKey = settings.elevenLabsApiKey;

    // Build request body
    const requestBody: VoiceTokenRequest = {};

    // Include custom credentials if user has enabled custom agent
    if (useCustomAgent && customAgentId && customApiKey) {
        requestBody.customAgentId = customAgentId;
        requestBody.customApiKey = customApiKey;
    }

    const serverUrl = getServerUrl();
    const response = await fetch(`${serverUrl}/v1/voice/token`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${auth.credentials.token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
        return {
            allowed: false,
            error: errorData.error || `Server error: ${response.status}`
        };
    }

    const data = await response.json();
    return data as VoiceTokenResponse;
}

// ElevenLabs Agent Management API
// These functions call ElevenLabs directly (not through our server)
// since the user is providing their own API key

const ELEVENLABS_API_BASE = 'https://api.elevenlabs.io/v1';
const AGENT_NAME = 'Happy Coding Assistant';

export interface ElevenLabsAgent {
    agent_id: string;
    name: string;
}

export interface FindAgentResult {
    success: boolean;
    agentId?: string;
    error?: string;
}

export interface CreateAgentResult {
    success: boolean;
    agentId?: string;
    error?: string;
    created?: boolean; // true if new agent was created, false if existing was updated
}

/**
 * Find an existing "Happy Coding Assistant" agent using the provided API key.
 * This is a read-only operation that doesn't mutate anything.
 */
export async function findHappyAgent(apiKey: string): Promise<FindAgentResult> {
    try {
        const response = await fetch(`${ELEVENLABS_API_BASE}/convai/agents`, {
            method: 'GET',
            headers: {
                'xi-api-key': apiKey,
                'Accept': 'application/json'
            }
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            const errorMessage = errorData.detail?.message || errorData.detail || `API error: ${response.status}`;
            return { success: false, error: errorMessage };
        }

        const data = await response.json();
        const agents: ElevenLabsAgent[] = data.agents || [];

        const happyAgent = agents.find(agent => agent.name === AGENT_NAME);

        if (happyAgent) {
            return { success: true, agentId: happyAgent.agent_id };
        } else {
            return { success: false, error: `No agent named "${AGENT_NAME}" found` };
        }
    } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : 'Network error' };
    }
}

/**
 * Create or update the "Happy Coding Assistant" agent with our default configuration.
 * If an agent with this name exists, it will be updated. Otherwise, a new one is created.
 */
export async function createOrUpdateHappyAgent(apiKey: string): Promise<CreateAgentResult> {
    try {
        // First, check if agent already exists
        const findResult = await findHappyAgent(apiKey);
        const existingAgentId = findResult.success ? findResult.agentId : null;

        // Build agent configuration
        const agentConfig = buildAgentConfig();

        let response: Response;
        let created = false;

        if (existingAgentId) {
            // Update existing agent
            response = await fetch(`${ELEVENLABS_API_BASE}/convai/agents/${existingAgentId}`, {
                method: 'PATCH',
                headers: {
                    'xi-api-key': apiKey,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                body: JSON.stringify(agentConfig)
            });
        } else {
            // Create new agent
            response = await fetch(`${ELEVENLABS_API_BASE}/convai/agents/create`, {
                method: 'POST',
                headers: {
                    'xi-api-key': apiKey,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                body: JSON.stringify(agentConfig)
            });
            created = true;
        }

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            const errorMessage = errorData.detail?.message || errorData.detail || `API error: ${response.status}`;
            return { success: false, error: errorMessage };
        }

        const data = await response.json();
        const agentId = existingAgentId || data.agent_id;

        if (!agentId) {
            return { success: false, error: 'Failed to get agent ID from response' };
        }

        return { success: true, agentId, created };
    } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : 'Network error' };
    }
}

/**
 * Build the agent configuration matching voice_agent/setup-agent.sh
 */
function buildAgentConfig() {
    const systemPrompt = `
# Personality

You are Happy-Assistant or just "Assistant". You're a voice interface to Claude Code, designed to bridge communication between you and the Claude Code coding agent."

You're a friendly, proactive, and highly intelligent female with a world-class engineering background. Your approach is warm, witty, and relaxed, effortlessly balancing professionalism with a chill, approachable vibe.

# Environment

You are interacting with a user that is using Claude code, and you are serving as an intermediary to help them control Claude code with voice.

You will therefore pass through their requests to Claude, but also summarize messages that you see received back from Claude. The key thing is to be aware of the limitations of a spoken interface. Don't read a large file word by word, or a long number or hash code character-by-character. That's not helpful voice interaction. For example, do NOT read out long session IDs like "cmiabc123defqroeuth66bzaj", instead just say "Session with ID ending in 'ZAJ'". You should generally give a high-level summary of messages and tool responses you see flowing from Claude.

If the user addresses you directly "Assistant, read for me ..." respond accordingly. Conversely, if they explicitly refer to "Have Claude do X" that means pass it through. Otherwise, you must use the context to intelligently determine whether the request is a coding/development request that needs to go through to Claude, or something that you can answer yourself. Do NOT second guess what you think Claude code can or cannot do (i.e. based on what tools it does/does-not have access to). Just pass through the requests to Claude.

IMPORTANT: Be patient. After sending a message to Claude Code, wait silently for the response. Do NOT repeatedly ask "are you still there?" or similar questions. Claude Code may take time to process requests. Only speak when you have something meaningful to say or when responding to the user.

## Tools

You may learn at runtime of additional tools that you can run. These will include:
- Process permission requests (i.e. allow Claude to continue, Yes / No / Yes and don't ask again), or change the permission mode.
- Pend messages to Claude Code
- Detect and change the conversation language
- Skip a turn
# Tone

Your responses should be thoughtful, concise, and conversational—typically three sentences or fewer unless detailed explanation is necessary. Actively reflect on previous interactions, referencing conversation history to build rapport, demonstrate attentive listening, and prevent redundancy.

When formatting output for text-to-speech synthesis:
- Use ellipses ("...") for distinct, audible pauses
- Clearly pronounce special characters (e.g., say "dot" instead of ".")
- Spell out acronyms and carefully pronounce emails & phone numbers with appropriate spacing
- Use normalized, spoken language (no abbreviations, mathematical notation, or special alphabets)

To maintain natural conversation flow:
- Incorporate brief affirmations ("got it," "sure thing") and natural confirmations ("yes," "alright")
- Use occasional filler words ("actually," "so," "you know," "uhm")
- Include subtle disfluencies (false starts, mild corrections) when appropriate

# Goal

Your primary goal is to facilitate successful coding sessions via Claude Code.
**Technical users:** Assume a software developer audience.
# Guardrails

- Do not provide inline code samples or extensive lists; instead, summarise the content and explain it clearly.
- Treat uncertain or garbled user input as phonetic hints. Politely ask for clarification before making assumptions.
- **Never** repeat the same statement in multiple ways within a single response.
- Users may not always ask a question in every utterance—listen actively.
- Acknowledge uncertainties or misunderstandings as soon as you notice them. If you realize you've shared incorrect information, correct yourself immediately.
- Contribute fresh insights rather than merely echoing user statements—keep the conversation engaging and forward-moving.
- Mirror the user's energy:
- Terse queries: Stay brief.
- Curious users: Add light humor or relatable asides.
- Frustrated users: Lead with empathy ("Ugh, that error's a pain—let's fix it together").
`;

    return {
        name: AGENT_NAME,
        conversation_config: {
            agent: {
                first_message: "Hey! I'm your voice interface to Claude Code. What would you like me to help you with?",
                language: "en",
                prompt: {
                    prompt: systemPrompt,
                    llm: "gemini-2.5-flash",
                    temperature: 0.7,
                    max_tokens: 1024,
                    tools: [
                        {
                            type: "client",
                            name: "messageClaudeCode",
                            description: "Send a message to Claude Code. Use this tool to relay the user's coding requests, questions, or instructions to Claude Code. The message should be clear and complete.",
                            expects_response: true,
                            response_timeout_secs: 120,
                            parameters: {
                                type: "object",
                                required: ["message"],
                                properties: {
                                    message: {
                                        type: "string",
                                        description: "The message to send to Claude Code. Should contain the user's complete request or instruction."
                                    }
                                }
                            }
                        },
                        {
                            type: "client",
                            name: "processPermissionRequest",
                            description: "Process a permission request from Claude Code. Use this when the user wants to allow or deny a pending permission request.",
                            expects_response: true,
                            response_timeout_secs: 30,
                            parameters: {
                                type: "object",
                                required: ["decision"],
                                properties: {
                                    decision: {
                                        type: "string",
                                        description: "The user's decision: must be either 'allow' or 'deny'"
                                    }
                                }
                            }
                        }
                    ]
                }
            },
            turn: {
                turn_timeout: 30.0,
                silence_end_call_timeout: 600.0
            },
            tts: {
                voice_id: "cgSgspJ2msm6clMCkdW9", // Jessica
                model_id: "eleven_flash_v2",
                speed: 1.1
            }
        }
    };
}
