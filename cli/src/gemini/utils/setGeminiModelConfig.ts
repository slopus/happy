import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function setGeminiModelConfig(params: { model: string; homeDir?: string }): { configPath: string } {
  const homeDir = params.homeDir ?? homedir();
  const configDir = join(homeDir, '.gemini');
  const configPath = join(configDir, 'config.json');

  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }

  let config: any = {};
  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch {
      config = {};
    }
  }

  config.model = params.model;
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');

  return { configPath };
}

