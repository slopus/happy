/**
 * Split the arguments of an agent subcommand into Happy's own and the agent's.
 *
 * The daemon spawns every agent as
 * `node dist/index.mjs <agent> --happy-starting-mode remote --started-by daemon`,
 * and it is free to add more of its own flags later. Subcommands that run a
 * fixed command line (`happy agy`) can ignore what they do not recognise, but a
 * subcommand that forwards its extra arguments to the agent cannot: an ACP
 * agent given `--happy-starting-mode` sees an unknown flag and exits non-zero,
 * so the session never starts and the app reports a spawn failure.
 *
 * Recognising `--happy-*` as a namespace rather than listing today's flags is
 * the point. Special-casing one flag fixes one spawn and leaves the next flag
 * the daemon invents to break the same way, at a distance, in someone else's
 * commit.
 */

const HAPPY_FLAG_PREFIX = '--happy-';

/** Happy's own flags that predate the `--happy-` namespace. */
const LEGACY_VALUE_FLAGS = new Set(['--started-by']);
const LEGACY_BOOLEAN_FLAGS = new Set(['--verbose']);

export interface HappyAgentArgs {
    startedBy?: 'daemon' | 'terminal';
    verbose: boolean;
    /** Everything Happy did not claim, in order, to hand to the agent. */
    forwarded: string[];
}

/**
 * `args` is the subcommand's arguments, with the subcommand itself removed.
 *
 * A `--happy-x value` pair is consumed whole. The value is only taken when it
 * does not itself look like a flag, so a valueless `--happy-x --verbose` does
 * not swallow the flag after it.
 */
export function parseHappyAgentArgs(args: readonly string[]): HappyAgentArgs {
    let startedBy: 'daemon' | 'terminal' | undefined;
    let verbose = false;
    const forwarded: string[] = [];

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (LEGACY_VALUE_FLAGS.has(arg)) {
            if (arg === '--started-by') {
                const value = args[i + 1];
                if (value === 'daemon' || value === 'terminal') {
                    startedBy = value;
                }
            }
            i++;
            continue;
        }

        if (LEGACY_BOOLEAN_FLAGS.has(arg)) {
            verbose = true;
            continue;
        }

        if (arg.startsWith(HAPPY_FLAG_PREFIX)) {
            const takesSeparateValue = !arg.includes('=')
                && i + 1 < args.length
                && !args[i + 1].startsWith('-');
            if (takesSeparateValue) {
                i++;
            }
            continue;
        }

        forwarded.push(arg);
    }

    return { startedBy, verbose, forwarded };
}
