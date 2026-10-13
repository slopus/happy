package com.slopus.happy.crypto

// Mirrors packages/happy-app/sources/auth/authChallenge.ts, authQRStart.ts,
// authQRWait.ts and hooks/useConnectAccount.ts.

/** What POST /v1/auth takes: the account's Ed25519 public key signing a random challenge. */
class AuthChallenge(val challenge: ByteArray, val signature: ByteArray, val publicKey: ByteArray) {
    companion object {
        fun create(secret: ByteArray, random: RandomSource = SecureRandomSource): AuthChallenge {
            val keyPair = Sodium.signSeedKeypair(secret)
            val challenge = random.nextBytes(32)
            val signature = Sodium.signDetached(challenge, keyPair.secretKey)
            return AuthChallenge(challenge = challenge, signature = signature, publicKey = keyPair.publicKey)
        }
    }
}

/**
 * Linking a new phone to an existing account. The new phone creates a box key
 * pair and shows its public key as `happy:///account?<base64url>`; a phone that
 * already has the account seals the master secret to it and posts it to the
 * server; the new phone polls and opens it.
 */
object AccountLink {
    const val URL_PREFIX = "happy:///account?"

    /** The new phone's key pair (generateAuthKeyPair). */
    fun generateKeyPair(random: RandomSource = SecureRandomSource): Sodium.KeyPair =
        Sodium.boxSeedKeypair(random.nextBytes(32))

    fun linkUrl(publicKey: ByteArray): String = URL_PREFIX + encodeBase64(publicKey, Base64Variant.Url)

    /** The existing phone: parses the scanned URL, null if it is not an account link. */
    fun parseLinkUrl(url: String): ByteArray? {
        if (!url.startsWith(URL_PREFIX)) return null
        val key = try {
            decodeBase64(url.substring(URL_PREFIX.length), Base64Variant.Url)
        } catch (_: IllegalArgumentException) {
            return null
        }
        return key.takeIf { it.size == Sodium.BOX_PUBLIC_KEY_BYTES }
    }

    /** The existing phone: the response body for POST /v1/auth/account/response. */
    fun sealSecret(masterSecret: ByteArray, newDevicePublicKey: ByteArray, random: RandomSource = SecureRandomSource): ByteArray =
        encryptBox(masterSecret, newDevicePublicKey, random)

    /** The new phone: opens the server's `response`. */
    fun openSecret(response: ByteArray, keyPair: Sodium.KeyPair): ByteArray? = decryptBox(response, keyPair.secretKey)
}
