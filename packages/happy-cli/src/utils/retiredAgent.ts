/** Kept only to reject old commands and saved session flavors without changing their data. */
export const PERSONAL_AGENT_RETIRED_MESSAGE = 'The former Personal agent has been retired. Open Bots in Paws to use Rakazo. Existing conversation history is left untouched.';

export function retiredAgentMessage(flavor: unknown): string | null {
    return flavor === 'personal' ? PERSONAL_AGENT_RETIRED_MESSAGE : null;
}
