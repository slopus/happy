export function getMasterSecret(): string {
    const secret = process.env.HANDY_MASTER_SECRET;
    if (
        !secret || secret.trim().length < 32 ||
        [
            'local-dev-secret-not-for-production',
            'your-super-secret-key-for-local-development',
            'happy-dev-secret',
        ].includes(secret.trim())
    ) {
        throw new Error(
            'Set HANDY_MASTER_SECRET to a unique random value of at least 32 characters (openssl rand -hex 32). ' +
            'Published development secrets are not accepted. Preserve the existing secret for encrypted data; do not rotate it without a migration plan.'
        );
    }
    return secret;
}
