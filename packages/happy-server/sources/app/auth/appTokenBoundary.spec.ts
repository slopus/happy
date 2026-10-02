import { expect, it } from 'vitest';
import { auth } from './auth';
it('rejects scoped app credentials at the shared REST and socket account verifier, even before account auth initialization', async () => {
    expect(await auth.verifyToken('paws_app.00000000-0000-0000-0000-000000000000.' + 'x'.repeat(43))).toBeNull();
});
