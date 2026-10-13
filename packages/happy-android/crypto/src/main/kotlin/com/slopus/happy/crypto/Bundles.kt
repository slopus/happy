package com.slopus.happy.crypto

// Mirrors packages/happy-app/sources/encryption/libsodium.ts and blob.ts.

/**
 * Anonymous public-key encryption, happy-app's encryptBox.
 * Layout: ephemeral public key (32) || nonce (24) || crypto_box_easy output.
 * Randomness is drawn in the TS order: ephemeral secret key, then nonce.
 */
fun encryptBox(data: ByteArray, recipientPublicKey: ByteArray, random: RandomSource = SecureRandomSource): ByteArray {
    val ephemeral = Sodium.boxKeypair(random)
    val nonce = random.nextBytes(Sodium.BOX_NONCE_BYTES)
    val encrypted = requireNotNull(Sodium.boxEasy(data, nonce, recipientPublicKey, ephemeral.secretKey)) {
        "Invalid recipient public key"
    }
    return ephemeral.publicKey + nonce + encrypted
}

fun decryptBox(bundle: ByteArray, recipientSecretKey: ByteArray): ByteArray? {
    val headerLength = Sodium.BOX_PUBLIC_KEY_BYTES + Sodium.BOX_NONCE_BYTES
    if (bundle.size < headerLength + Sodium.BOX_MAC_BYTES) return null
    val ephemeralPublicKey = bundle.copyOfRange(0, Sodium.BOX_PUBLIC_KEY_BYTES)
    val nonce = bundle.copyOfRange(Sodium.BOX_PUBLIC_KEY_BYTES, headerLength)
    val encrypted = bundle.copyOfRange(headerLength, bundle.size)
    return Sodium.boxOpenEasy(encrypted, nonce, ephemeralPublicKey, recipientSecretKey)
}

/**
 * Symmetric encryption of raw bytes, happy-app's encryptBlob and the body of
 * encryptSecretBox. Layout: nonce (24) || crypto_secretbox_easy output.
 */
fun encryptBlob(data: ByteArray, key: ByteArray, random: RandomSource = SecureRandomSource): ByteArray {
    val nonce = random.nextBytes(Sodium.SECRETBOX_NONCE_BYTES)
    return nonce + Sodium.secretboxEasy(data, nonce, key)
}

fun decryptBlob(bundle: ByteArray, key: ByteArray): ByteArray? {
    if (bundle.size < Sodium.SECRETBOX_NONCE_BYTES + Sodium.SECRETBOX_MAC_BYTES) return null
    val nonce = bundle.copyOfRange(0, Sodium.SECRETBOX_NONCE_BYTES)
    return Sodium.secretboxOpenEasy(bundle.copyOfRange(Sodium.SECRETBOX_NONCE_BYTES, bundle.size), nonce, key)
}
