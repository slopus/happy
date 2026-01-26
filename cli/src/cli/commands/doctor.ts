import { killRunawayHappyProcesses } from '@/daemon/doctor';
import { runDoctorCommand } from '@/ui/doctor';

import type { CommandContext } from '@/cli/commandRegistry';

export async function handleDoctorCliCommand(context: CommandContext): Promise<void> {
  const args = context.args;

  if (args[1] === 'clean') {
    const result = await killRunawayHappyProcesses();
    console.log(`Cleaned up ${result.killed} runaway processes`);
    if (result.errors.length > 0) {
      console.log('Errors:', result.errors);
    }
    process.exit(0);
  }

  await runDoctorCommand();
}

