// libsodium-wrappers, as happy-app's libsodium.lib.web.ts exports it, except
// that crypto_box_keypair takes its secret key from the scripted random
// source. libsodium's own crypto_box_keypair is randombytes(32) followed by
// crypto_scalarmult_base, so this changes where the bytes come from, not what
// is computed from them.
import { createRequire } from 'node:module';
import { nextRandom } from './random.mjs';

// The package's ESM build fails to load under Node; the CommonJS build is the same code.
const sodium = createRequire(import.meta.url)('libsodium-wrappers');

await sodium.ready;

const scripted = Object.create(sodium);
scripted.crypto_box_keypair = () => {
    const privateKey = nextRandom(sodium.crypto_box_SECRETKEYBYTES);
    return { keyType: 'x25519', privateKey, publicKey: sodium.crypto_scalarmult_base(privateKey) };
};

export default scripted;
