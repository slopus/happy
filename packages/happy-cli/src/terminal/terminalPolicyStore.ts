/**
 * Persisted approval policy for remote shells on this machine.
 *
 * Three modes (default: `per-session`):
 * - `none`               open shells without an extra approval step
 * - `once-per-machine`   require one approval, then remember it
 * - `per-session`        require approval for every new terminal
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ApprovalPolicy, isApprovalPolicy } from './types';

interface PersistedTerminalPolicy {
    version: 1;
    approvalPolicy: ApprovalPolicy;
    approvedOnce: boolean;
}

const DEFAULT_POLICY: ApprovalPolicy = 'per-session';

export class TerminalPolicyStore {
    private approvalPolicy: ApprovalPolicy = DEFAULT_POLICY;
    private approvedOnce = false;
    private persistQueue: Promise<void> = Promise.resolve();

    constructor(private readonly file: string) {}

    async load(): Promise<void> {
        if (!existsSync(this.file)) {
            return;
        }
        try {
            const raw = JSON.parse(await readFile(this.file, 'utf8')) as Partial<PersistedTerminalPolicy>;
            if (isApprovalPolicy(raw.approvalPolicy)) {
                this.approvalPolicy = raw.approvalPolicy;
            }
            this.approvedOnce = raw.approvedOnce === true;
        } catch {
            // Corrupt policy file: fall back to defaults and rewrite on next change.
            this.approvalPolicy = DEFAULT_POLICY;
            this.approvedOnce = false;
        }
    }

    get(): ApprovalPolicy {
        return this.approvalPolicy;
    }

    getApprovedOnce(): boolean {
        return this.approvedOnce;
    }

    async set(policy: ApprovalPolicy): Promise<void> {
        if (!isApprovalPolicy(policy)) {
            throw new Error(`Unsupported approval policy: ${String(policy)}`);
        }
        this.approvalPolicy = policy;
        if (policy !== 'once-per-machine') {
            this.approvedOnce = false;
        }
        await this.persist();
    }

    async approveOnce(): Promise<void> {
        this.approvedOnce = true;
        await this.persist();
    }

    private async persist(): Promise<void> {
        const payload: PersistedTerminalPolicy = {
            version: 1,
            approvalPolicy: this.approvalPolicy,
            approvedOnce: this.approvedOnce,
        };
        const write = this.persistQueue
            .catch(() => undefined)
            .then(() => this.writePolicy(payload));
        this.persistQueue = write;
        await write;
    }

    private async writePolicy(payload: PersistedTerminalPolicy): Promise<void> {
        const dir = dirname(this.file);
        if (!existsSync(dir)) {
            await mkdir(dir, { recursive: true });
        }
        const tmp = `${this.file}.tmp`;
        await writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
        await rename(tmp, this.file);
    }
}
