import * as Crypto from 'expo-crypto';
import * as TweetNacl from 'tweetnacl';

export function authChallenge(secret: Uint8Array) {
    const keypair = TweetNacl.sign.keyPair.fromSeed(secret);
    const challenge = Crypto.getRandomBytes(32);
    const signature = TweetNacl.sign.detached(challenge, keypair.secretKey);
    return { challenge, signature, publicKey: keypair.publicKey };
}