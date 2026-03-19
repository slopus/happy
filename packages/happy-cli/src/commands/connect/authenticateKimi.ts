/**
 * Kimi/Moonshot authentication helper
 *
 * Kimi CLI authenticates via MOONSHOT_API_KEY. This module prompts the user
 * for their API key and returns it in a token-compatible format so it can
 * be stored in Happy cloud alongside other vendor tokens.
 */

import * as readline from 'readline';

export interface KimiAuthTokens {
    access_token: string;
    token_type: string;
}

/**
 * Prompt the user for their Moonshot API key.
 *
 * Kimi/Moonshot doesn't use OAuth — the CLI reads MOONSHOT_API_KEY
 * from the environment. We wrap it in the same token shape used by other
 * vendors so the Happy cloud can store and relay it uniformly.
 */
export async function authenticateKimi(): Promise<KimiAuthTokens> {
    console.log('🔑 Kimi uses a Moonshot API key for authentication.');
    console.log('   Get your key from: https://platform.moonshot.cn/console/api-keys');
    console.log('');

    const apiKey = await promptForInput('Enter your Moonshot API key: ');

    if (!apiKey || !apiKey.trim()) {
        throw new Error('No API key provided');
    }

    const trimmed = apiKey.trim();

    // Basic format check — Moonshot keys start with "sk-"
    if (!trimmed.startsWith('sk-')) {
        console.log('⚠️  Warning: Moonshot API keys usually start with "sk-".');
        console.log('   Continuing anyway — double-check the key if authentication fails.');
    }

    console.log('');
    console.log('🎉 API key received!');

    return {
        access_token: trimmed,
        token_type: 'Bearer',
    };
}

function promptForInput(question: string): Promise<string> {
    return new Promise((resolve) => {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer);
        });
    });
}
