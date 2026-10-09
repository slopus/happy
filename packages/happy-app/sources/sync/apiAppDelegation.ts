/** Only the current service protocol can authorize an application. */
export function appAuthorizationProtocol(protocol: unknown): 'ai-services/1' | 'unsupported' {
    return protocol === 'ai-services/1' ? protocol : 'unsupported';
}

/** Seals personal keys on the owner client. Only recipient ciphertext goes to the Paws backend. */
export async function sealServiceConsent(input: {
    pairing: import('./apiAIServices').ServicePairing;
    service: import('@slopus/happy-wire').ServiceRef;
    scope: import('@slopus/happy-wire').ServiceGrantScope;
    workers: import('./apiAIServices').AIServiceWorker[];
}) {
    const { pairing, service, scope, workers } = input;
    if (pairing.protocol !== 'ai-services/1' || pairing.expiresAt <= Date.now() || scope.appId !== pairing.app.appId || scope.serviceId !== service.id || !service.enabled || scope.permissions.some(p => !pairing.app.capabilities.includes(p))) throw new Error('授权范围无效或请求已过期。');
    const [{ getRandomBytes }, { encodeBase64, decodeBase64 }, { encryptBox }, { ServiceGrantScopeSchema }] = await Promise.all([
        import('expo-crypto'), import('@/encryption/base64'), import('@/encryption/libsodium'), import('@slopus/happy-wire'),
    ]);
    ServiceGrantScopeSchema.parse(scope);
    const recipients = [...new Set(scope.targets.map(t => t.machineId))].map(machineId => {
        const worker = workers.find(w => w.machineId === machineId && w.serviceProtocol === 'ai-services/1');
        if (!worker?.servicePublicKey || decodeBase64(worker.servicePublicKey).length !== 32) throw new Error('设备的加密密钥不可用。请刷新设备状态。');
        return { machineId, publicKey: worker.servicePublicKey };
    });
    if (decodeBase64(pairing.publicKey).length !== 32) throw new Error('应用加密密钥无效。');
    const messageKey = getRandomBytes(32);
    try {
        const plaintext = { protocol: 'ai-services/1', grantId: pairing.id, ownerId: service.ownerId, appId: scope.appId, serviceId: service.id, scope, messageKey: encodeBase64(messageKey) };
        const seal = (value: unknown, key: string) => encodeBase64(encryptBox(new TextEncoder().encode(JSON.stringify(value)), decodeBase64(key)));
        return { scope, appEnvelope: seal(plaintext, pairing.publicKey), machineEnvelopes: Object.fromEntries(recipients.map(r => [r.machineId, seal({ ...plaintext, machineId: r.machineId }, r.publicKey)])) };
    } finally { messageKey.fill(0); }
}
