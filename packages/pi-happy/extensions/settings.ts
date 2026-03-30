import { readFile } from 'node:fs/promises';

import { z } from 'zod';

const settingsSchema = z.object({
  machineId: z.string().min(1).optional(),
}).passthrough();

export type PiHappySettings = {
  machineId?: string;
};

export async function loadSettings(settingsFile: string): Promise<PiHappySettings> {
  try {
    const raw = await readFile(settingsFile, 'utf8');
    const parsed = settingsSchema.parse(JSON.parse(raw));

    return {
      machineId: parsed.machineId,
    };
  } catch {
    return {
      machineId: undefined,
    };
  }
}
