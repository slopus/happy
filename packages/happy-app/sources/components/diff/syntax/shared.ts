import { SyntaxService } from './service';
import { createSyntaxWorker } from './worker';

/**
 * Retain the queue/runtime across Fast Refresh as well as remounts. Worklets
 * has no terminate API, so refreshing a module must not allocate more runtimes.
 * Reload the app after changing worker code (the generated factory is immutable).
 */
const globals = globalThis as typeof globalThis & { __happyDiffSyntaxService?: SyntaxService };
export const diffSyntax = globals.__happyDiffSyntaxService ??= new SyntaxService(createSyntaxWorker());