import os from 'node:os';
import type { MachineMetadata } from '@/api/types';
import { configuration } from '@/configuration';
import { projectPath } from '@/projectPath';
import { detectCLIAvailability } from '@/utils/detectCLI';
import { detectResumeSupport } from '@/resume/localHappyAgentAuth';
import packageJson from '../../package.json';

// Prepare initial metadata
// Suffix host with `-dev` for the HAPPY_VARIANT=dev variant so the dev daemon
// is visually distinct from the stable one in the machine list (they otherwise
// share the same hostname and look identical).
const hostSuffix = process.env.HAPPY_VARIANT === 'dev' ? '-dev' : '';
export const initialMachineMetadata: MachineMetadata = {
  host: os.hostname() + hostSuffix,
  platform: os.platform(),
  happyCliVersion: packageJson.version,
  homeDir: os.homedir(),
  happyHomeDir: configuration.happyHomeDir,
  happyLibDir: projectPath(),
  cliAvailability: detectCLIAvailability(),
  resumeSupport: { ...detectResumeSupport(), rpcAvailable: true },
};
