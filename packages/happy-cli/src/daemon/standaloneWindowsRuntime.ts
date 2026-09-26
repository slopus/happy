import { randomUUID } from 'node:crypto';
import { copyFile, constants } from 'node:fs/promises';
import { join } from 'node:path';
import { StandaloneDrain } from './standaloneDrain';
import { StandaloneLaunchControl } from './standaloneLaunchControl';
import { StandaloneLaunchJournal, protectStandaloneObservationDirectory } from './standaloneLaunchJournal';
import { StandaloneLaunchFailure, StandaloneSessionOwner } from './standaloneSessionOwner';
import { launchWindowsSession, probeWindowsProcessIdentity, readWindowsSessionReceipt, verifyWindowsSessionLauncher, WindowsSessionLaunchError } from './windowsSessionLauncher';
import { resolveHappyCliSpawnCommand } from '../utils/spawnHappyCLI';

export function readStandaloneCandidateId(env: NodeJS.ProcessEnv): string | undefined {
  const id = env.HAPPY_STANDALONE_WINDOWS_CANDIDATE_ID;
  if (id !== undefined && !/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid standalone candidate identity');
  return id;
}
export function candidateDaemonPresence(pid: number): 'live' | 'gone' | 'unknown' {
  if (!Number.isInteger(pid) || pid <= 0) return 'unknown';
  try { process.kill(pid, 0); return 'live'; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'gone' : 'unknown'; }
}
type CandidateProcessState = { pid: number; windowsProcessIdentity?: { pid: number; creationFileTime: string } };
/** A PID may be alive after the daemon incarnation that owned it has exited. */
export async function resolveCandidateDaemonPresence(existing: CandidateProcessState,
  probe: (pid: number) => Promise<{ pid: number; creationFileTime: string }>): Promise<'live' | 'gone' | 'unknown'> {
  if (!Number.isInteger(existing.pid) || existing.pid <= 0 || existing.pid > 0xffffffff) return 'unknown';
  const presence = candidateDaemonPresence(existing.pid);
  if (presence === 'gone') return presence;
  const expected = existing.windowsProcessIdentity;
  if (!expected) return presence; // Legacy records have no incarnation proof.
  const validTime = (value: string) => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n;
  if (expected.pid !== existing.pid || !validTime(expected.creationFileTime)) return 'unknown';
  try {
    const observed = await probe(existing.pid);
    if (observed.pid !== existing.pid || !validTime(observed.creationFileTime)) return 'unknown';
    return observed.creationFileTime === expected.creationFileTime ? 'live' : 'gone';
  } catch { return 'unknown'; }
}
export function inspectStandaloneCandidatePresence(homeDir: string, env: NodeJS.ProcessEnv, existing: CandidateProcessState) {
  return resolveCandidateDaemonPresence(existing, async pid => {
    const source = env.HAPPY_STANDALONE_WINDOWS_LAUNCHER;
    const digest = env.HAPPY_STANDALONE_WINDOWS_LAUNCHER_SHA256;
    if (!source || !digest) throw new Error('Verified native identity probe unavailable');
    const { helperPath } = await prepareStandaloneLauncher(homeDir, source, digest);
    return probeWindowsProcessIdentity({ helperPath, helperSha256: digest }, pid);
  });
}
async function prepareStandaloneLauncher(homeDir: string, source: string, digest: string) {
  await verifyWindowsSessionLauncher({ helperPath: source, helperSha256: digest });
  const nativeDirectory = join(homeDir, 'standalone-native-v1');
  await protectStandaloneObservationDirectory(nativeDirectory, true);
  // Both startup identity inspection and session launch execute the same protected copy.
  const helperPath = join(nativeDirectory, `launcher-${digest.toLowerCase()}.exe`);
  try { await copyFile(source, helperPath, constants.COPYFILE_EXCL); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  await protectStandaloneObservationDirectory(nativeDirectory);
  await verifyWindowsSessionLauncher({ helperPath, helperSha256: digest });
  return { helperPath, nativeDirectory };
}
/** A candidate never adopts or replaces a differently identified daemon in the same home. */
export function assertStandaloneCandidateIdentity(requested: string | undefined,
  existing: { windowsCandidateId?: string; state?: string } | null | undefined, presence: 'live' | 'gone' | 'unknown' = 'unknown'): void {
  if (existing && presence === 'unknown' && (requested || existing.windowsCandidateId)) {
    throw new Error('Trial daemon process identity could not be verified. Stop that trial through its app, or use a separate isolated home for this candidate.');
  }
  if (existing && presence !== 'gone' && (requested || existing.windowsCandidateId)
    && requested !== existing.windowsCandidateId) throw new Error('A different trial daemon is running or could not be verified in this home. Stop that trial through its app, or use a separate isolated home for this candidate.');
}

/** Explicit local-trial composition. Public CLI versions alone never advertise this capability. */
export async function createStandaloneWindowsRuntime(options: {
  homeDir: string; env: NodeJS.ProcessEnv; managed: boolean; getChildren(): readonly { pid: number }[]; onRetired?(pid: number, launchId: string): void;
}) {
  const candidateId = readStandaloneCandidateId(options.env);
  const source = options.env.HAPPY_STANDALONE_WINDOWS_LAUNCHER;
  const digest = options.env.HAPPY_STANDALONE_WINDOWS_LAUNCHER_SHA256;
  // Consume before awaits: provider tools and nested daemons must not inherit activation.
  delete options.env.HAPPY_STANDALONE_WINDOWS_LAUNCHER;
  delete options.env.HAPPY_STANDALONE_WINDOWS_LAUNCHER_SHA256;
  delete options.env.HAPPY_STANDALONE_WINDOWS_CANDIDATE_ID;
  if (source === undefined && digest === undefined) {
    if (candidateId !== undefined) throw new Error('Standalone candidate activation requires a native launcher');
    return undefined;
  }
  if (process.platform !== 'win32' || process.arch !== 'x64' || options.managed || !source || !digest) {
    throw new Error('Standalone Windows launcher requires an unmanaged Windows x64 trial');
  }
  const { helperPath, nativeDirectory } = await prepareStandaloneLauncher(options.homeDir, source, digest);
  const identity = await probeWindowsProcessIdentity({ helperPath, helperSha256: digest }, process.pid);
  if (identity.status !== 'present') throw new Error('Cannot establish Windows daemon process identity');
  const windowsProcessIdentity = { pid: identity.pid, creationFileTime: identity.creationFileTime };
  const journal = await StandaloneLaunchJournal.open(join(options.homeDir, 'standalone-launches-v1'));
  const instanceId = randomUUID();
  const control = await StandaloneLaunchControl.open(instanceId);
  const readReceipt = async (intent: { instanceId: string; launchId: string }) => {
    await protectStandaloneObservationDirectory(nativeDirectory);
    return readWindowsSessionReceipt(join(nativeDirectory, `${intent.launchId}.json`), intent);
  };
  try {
    const owner = await StandaloneSessionOwner.open({ instanceId, journal, control, readReceipt, onRetired: options.onRetired,
      hasUnboundChildren: owned => options.getChildren().some(child => !owned.has(child.pid)),
      isNoProcessError: error => error instanceof WindowsSessionLaunchError,
      launch: async input => {
        await protectStandaloneObservationDirectory(nativeDirectory);
        const command = resolveHappyCliSpawnCommand(input.args);
        const native = await launchWindowsSession({ helperPath, helperSha256: digest,
          executable: process.execPath, args: command.args, cwd: input.cwd, env: input.env,
          instanceId: input.instanceId, launchId: input.launchId,
          receiptPath: join(nativeDirectory, `${input.launchId}.json`),
        });
        let pid: number;
        try { pid = await native.ready; }
        catch (error) {
          // The helper may still own a suspended root. Request only pre-resume rollback,
          // and require its durable receipt before declaring that nothing was launched.
          native.cancelBeforeResume();
          const receipt = await native.exit;
          if (!receipt.launched) throw new WindowsSessionLaunchError('Native child was not created');
          throw new StandaloneLaunchFailure(receipt);
        }
        return { pid, childProcess: native.child, resume: native.resume,
          cancelBeforeResume: native.cancelBeforeResume, terminate: native.terminate, exit: native.exit };
      },
    });
    return { owner, windowsProcessIdentity, candidateId, drain: new StandaloneDrain({ instanceId,
      targets: [{ platform: 'win32', arch: 'x64', provider: 'codex', mode: 'standard' }],
      canTerminate: id => owner.canTerminate(id),
      terminate: id => owner.resolveTermination(id),
      freeze: (signal, budget) => owner.freeze(signal, budget),
      drain: (launchId, signal, budget) => owner.drain(launchId, signal, budget),
    }) };
  } catch (error) { await control.close(); throw error; }
}
