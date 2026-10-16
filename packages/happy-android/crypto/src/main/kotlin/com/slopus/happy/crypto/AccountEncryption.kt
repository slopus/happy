package com.slopus.happy.crypto

/**
 * Keys derived from the 32-byte account master secret, mirroring
 * packages/happy-app/sources/sync/encryption/encryption.ts (Encryption.create).
 *
 * Records (sessions, machines, artifacts) each carry their own 32-byte data
 * key, wrapped to the account's content public key. This class unwraps those
 * keys; [DataKeyCipher] then opens the record. Account settings are the one
 * payload sealed directly with the master secret.
 */
class AccountEncryption private constructor(
    masterSecret: ByteArray,
    private val random: RandomSource,
) {
    private val contentKeyPair: Sodium.KeyPair

    /** Content key pair public key. happy-app names this `contentDataKey`; terminal auth v2 sends it to the CLI. */
    val contentPublicKey: ByteArray

    /** 16 lowercase hex characters identifying the account in analytics without revealing it. */
    val anonId: String

    /** Key for hashing provider account ids in analytics. */
    val providerAccountKey: ByteArray

    private val settingsCipher: SecretBoxCipher

    /** Secretbox key for blobs of records without a data key (legacy projects' avatars). */
    val masterBlobKey: ByteArray

    init {
        require(masterSecret.size == 32) { "Invalid master secret length" }
        val contentDataKey = deriveKey(masterSecret, "Happy EnCoder", listOf("content"))
        contentKeyPair = Sodium.boxSeedKeypair(contentDataKey)
        contentPublicKey = contentKeyPair.publicKey
        anonId = encodeHex(deriveKey(masterSecret, "Happy Coder", listOf("analytics", "id")))
            .substring(0, 16)
            .lowercase()
        providerAccountKey = deriveKey(masterSecret, "Happy Coder", listOf("analytics", "provider-account"))
        settingsCipher = SecretBoxCipher(masterSecret, random)
        masterBlobKey = deriveKey(masterSecret, "Happy Blobs", listOf("master"))
    }

    /**
     * Unwraps a record's data key: base64 of version byte 0 || box bundle.
     * Never throws; one malformed key must not fail a whole sync page.
     */
    fun decryptDataEncryptionKey(encrypted: String): ByteArray? {
        val bytes = try {
            decodeBase64(encrypted)
        } catch (_: IllegalArgumentException) {
            return null
        }
        if (bytes.isEmpty() || bytes[0] != DATA_KEY_VERSION) return null
        return decryptBox(bytes.copyOfRange(1, bytes.size), contentKeyPair.secretKey)
    }

    /** Wraps a new record data key to this account. Returns raw bytes; the wire carries base64. */
    fun encryptDataEncryptionKey(dataKey: ByteArray): ByteArray =
        byteArrayOf(DATA_KEY_VERSION) + encryptBox(dataKey, contentKeyPair.publicKey, random)

    /** Cipher for account settings (`/v1/account/settings`). */
    fun settingsCipher(): PayloadCipher = settingsCipher

    fun dataKeyCipher(dataKey: ByteArray): PayloadCipher = DataKeyCipher(dataKey, random)

    companion object {
        private const val DATA_KEY_VERSION: Byte = 0

        fun create(masterSecret: ByteArray, random: RandomSource = SecureRandomSource): AccountEncryption =
            AccountEncryption(masterSecret, random)

        /** Secretbox key for a record's binary blobs (attachments, avatars), separate from its message key. */
        fun blobKeyForDataKey(dataKey: ByteArray): ByteArray = deriveKey(dataKey, "Happy Blobs", listOf("session"))

        /** A fresh random data key for a record this device creates. */
        fun generateDataKey(random: RandomSource = SecureRandomSource): ByteArray = random.nextBytes(Aes256Gcm.KEY_BYTES)
    }
}
