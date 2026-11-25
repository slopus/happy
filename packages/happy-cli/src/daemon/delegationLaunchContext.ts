import { DELEGATION_REPORTER_ENV, parseDelegationReporterDescriptor } from './delegation/journal';

type Descriptor = NonNullable<ReturnType<typeof parseDelegationReporterDescriptor>>;
let consumed = false;
let descriptor: Descriptor | null = null;

/** Consume before starting any native backend; only this Paws worker retains the binding. */
export function delegationLaunchContext(): Descriptor | null {
    if (!consumed) {
        consumed = true;
        const raw = process.env[DELEGATION_REPORTER_ENV];
        delete process.env[DELEGATION_REPORTER_ENV];
        descriptor = parseDelegationReporterDescriptor(raw);
        if (raw && !descriptor) throw new Error('Invalid delegated task launch binding');
    }
    return descriptor;
}
