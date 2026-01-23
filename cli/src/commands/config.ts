import chalk from 'chalk';
import { readSettings, updateSettings } from '@/persistence';

type ConfigKey = 'attribution';

const CONFIG_KEYS: Record<ConfigKey, {
  description: string;
  type: 'boolean';
  default: boolean;
}> = {
  attribution: {
    description: 'Include Happy co-author credits in git commits',
    type: 'boolean',
    default: false
  }
};

export async function handleConfigCommand(args: string[]): Promise<void> {
  const subcommand = args[0];

  if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    showConfigHelp();
    return;
  }

  switch (subcommand) {
    case 'get':
      await handleConfigGet(args[1]);
      break;
    case 'set':
      await handleConfigSet(args[1], args[2]);
      break;
    case 'list':
      await handleConfigList();
      break;
    default:
      console.error(chalk.red(`Unknown config subcommand: ${subcommand}`));
      showConfigHelp();
      process.exit(1);
  }
}

function showConfigHelp(): void {
  console.log(`
${chalk.bold('happy config')} - Configuration management

${chalk.bold('Usage:')}
  happy config get <key>          Get a configuration value
  happy config set <key> <value>  Set a configuration value
  happy config list               List all configuration values
  happy config help               Show this help message

${chalk.bold('Available settings:')}
  attribution    ${chalk.gray('Include Happy co-author credits in git commits (default: false)')}

${chalk.bold('Examples:')}
  happy config set attribution true    ${chalk.gray('Enable commit attribution')}
  happy config set attribution false   ${chalk.gray('Disable commit attribution')}
  happy config get attribution         ${chalk.gray('Check current attribution setting')}
`);
}

async function handleConfigGet(key: string | undefined): Promise<void> {
  if (!key) {
    console.error(chalk.red('Missing key. Usage: happy config get <key>'));
    process.exit(1);
  }

  if (!isValidConfigKey(key)) {
    console.error(chalk.red(`Unknown config key: ${key}`));
    console.log(chalk.gray(`Available keys: ${Object.keys(CONFIG_KEYS).join(', ')}`));
    process.exit(1);
  }

  const settings = await readSettings();
  const value = getConfigValue(settings, key);
  const config = CONFIG_KEYS[key];
  const isDefault = value === config.default;

  console.log(`${key}: ${chalk.cyan(String(value))}${isDefault ? chalk.gray(' (default)') : ''}`);
}

async function handleConfigSet(key: string | undefined, value: string | undefined): Promise<void> {
  if (!key || value === undefined) {
    console.error(chalk.red('Missing key or value. Usage: happy config set <key> <value>'));
    process.exit(1);
  }

  if (!isValidConfigKey(key)) {
    console.error(chalk.red(`Unknown config key: ${key}`));
    console.log(chalk.gray(`Available keys: ${Object.keys(CONFIG_KEYS).join(', ')}`));
    process.exit(1);
  }

  const config = CONFIG_KEYS[key];
  let parsedValue: boolean;

  if (config.type === 'boolean') {
    if (value === 'true' || value === '1' || value === 'yes') {
      parsedValue = true;
    } else if (value === 'false' || value === '0' || value === 'no') {
      parsedValue = false;
    } else {
      console.error(chalk.red(`Invalid boolean value: ${value}`));
      console.log(chalk.gray('Use: true, false, 1, 0, yes, or no'));
      process.exit(1);
    }
  } else {
    parsedValue = value as unknown as boolean;
  }

  await setConfigValue(key, parsedValue);

  // Show confirmation with context
  if (key === 'attribution') {
    if (parsedValue) {
      console.log(chalk.green('✓ Attribution enabled'));
      console.log(chalk.gray('  Commits will include Happy co-author credits'));
    } else {
      console.log(chalk.green('✓ Attribution disabled'));
      console.log(chalk.gray('  Commits will not include Happy co-author credits'));
    }
  } else {
    console.log(chalk.green(`✓ Set ${key} = ${parsedValue}`));
  }
}

async function handleConfigList(): Promise<void> {
  const settings = await readSettings();

  console.log(chalk.bold('\nHappy Configuration\n'));

  for (const [key, config] of Object.entries(CONFIG_KEYS)) {
    const value = getConfigValue(settings, key as ConfigKey);
    const isDefault = value === config.default;

    console.log(`  ${chalk.cyan(key)}: ${value}${isDefault ? chalk.gray(' (default)') : ''}`);
    console.log(chalk.gray(`    ${config.description}`));
    console.log('');
  }
}

function isValidConfigKey(key: string): key is ConfigKey {
  return Object.hasOwn(CONFIG_KEYS, key);
}

function getConfigValue(settings: Awaited<ReturnType<typeof readSettings>>, key: ConfigKey): boolean {
  if (key === 'attribution') {
    return settings.includeAttribution ?? CONFIG_KEYS.attribution.default;
  }
  // Exhaustive check - this should never be reached
  const _exhaustive: never = key;
  return _exhaustive;
}

async function setConfigValue(key: ConfigKey, value: boolean): Promise<void> {
  await updateSettings(settings => {
    if (key === 'attribution') {
      return { ...settings, includeAttribution: value };
    }
    // Exhaustive check - this should never be reached
    const _exhaustive: never = key;
    return _exhaustive;
  });
}
