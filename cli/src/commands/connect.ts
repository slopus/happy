import chalk from 'chalk';
import { readCredentials } from '@/persistence';
import { ApiClient } from '@/api/api';
import { authenticateCodex } from './connect/authenticateCodex';
import { authenticateClaude } from './connect/authenticateClaude';
import { authenticateGemini } from './connect/authenticateGemini';

/**
 * Handle connect subcommand
 * 
 * Implements connect subcommands for storing AI vendor API keys:
 * - connect codex: Store OpenAI API key in Happy cloud
 * - connect claude: Store Anthropic API key in Happy cloud
 * - connect gemini: Store Gemini API key in Happy cloud
 * - connect help: Show help for connect command
 */
export async function handleConnectCommand(args: string[]): Promise<void> {
    const subcommand = args[0];

    if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
        showConnectHelp();
        return;
    }

    switch (subcommand.toLowerCase()) {
        case 'codex':
            await handleConnectVendor('codex', 'OpenAI');
            break;
        case 'claude':
            await handleConnectVendor('claude', 'Anthropic');
            break;
        case 'gemini':
            await handleConnectVendor('gemini', 'Gemini');
            break;
        default:
            console.error(chalk.red(`Unknown connect target: ${subcommand}`));
            showConnectHelp();
            process.exit(1);
    }
}

function showConnectHelp(): void {
    console.log(`
${chalk.bold('happy connect')} - Connect AI vendor API keys to Happy cloud

${chalk.bold('Usage:')}
  happy connect codex        Store your Codex API key in Happy cloud
  happy connect claude       Store your Anthropic API key in Happy cloud
  happy connect gemini       Store your Gemini API key in Happy cloud
  happy connect help         Show this help message

${chalk.bold('Description:')}
  The connect command allows you to securely store your AI vendor API keys
  in Happy cloud. This enables you to use these services through Happy
  without exposing your API keys locally.

${chalk.bold('Examples:')}
  happy connect codex
  happy connect claude
  happy connect gemini

${chalk.bold('Notes:')} 
  • You must be authenticated with Happy first (run 'happy auth login')
  • API keys are encrypted and stored securely in Happy cloud
  • You can manage your stored keys at app.happy.engineering
`);
}

async function handleConnectVendor(vendor: 'codex' | 'claude' | 'gemini', displayName: string): Promise<void> {
    console.log(chalk.bold(`\n🔌 Connecting ${displayName} to Happy cloud\n`));

    // Check if authenticated
    const credentials = await readCredentials();
    if (!credentials) {
        console.log(chalk.yellow('⚠️  Not authenticated with Happy'));
        console.log(chalk.gray('  Please run "happy auth login" first'));
        process.exit(1);
    }

    // Create API client
    const api = await ApiClient.create(credentials);

    // Handle vendor authentication
    if (vendor === 'codex') {
        console.log('🚀 Registering Codex token with server');
        const codexAuthTokens = await authenticateCodex();
        await api.registerVendorToken('openai', { oauth: codexAuthTokens });
        console.log('✅ Codex token registered with server');
        process.exit(0);
    } else if (vendor === 'claude') {
        console.log('🚀 Registering Anthropic token with server');
        const anthropicAuthTokens = await authenticateClaude();
        await api.registerVendorToken('anthropic', { oauth: anthropicAuthTokens });
        console.log('✅ Anthropic token registered with server');
        process.exit(0);
    } else if (vendor === 'gemini') {
        console.log('🚀 Registering Gemini token with server');
        const geminiAuthTokens = await authenticateGemini();
        await api.registerVendorToken('gemini', { oauth: geminiAuthTokens });
        console.log('✅ Gemini token registered with server');
        process.exit(0);
    } else {
        throw new Error(`Unsupported vendor: ${vendor}`);
    }
}