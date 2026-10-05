import { createScopedServiceTransport, type ScopedTransportOptions } from './scopedTransport';
import { AIServiceClientError, type GrantReceipt } from './types';
/** Backend only. Provision this receipt privately; never serialize these options into browser config. */
export function createNodePlatformTransport(options: ScopedTransportOptions & {
    receipt: GrantReceipt;
}) {
    if (typeof window !== 'undefined')
        throw new AIServiceClientError('permission-denied');
    if (options.origin !== undefined)
        throw new AIServiceClientError('permission-denied');
    return createScopedServiceTransport(options, 'platform-grant', options.receipt);
}
export { createPlatformServiceHandler } from './nodePlatformHandler';
export type { PlatformHostAuthorization, PlatformOperation } from './nodePlatformHandler';
