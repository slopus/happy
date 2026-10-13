package com.slopus.happy.crypto

import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement

// Mirrors packages/happy-app/sources/sync/encryption/encryptor.ts: every
// encrypted record on the wire is a JSON value, serialized, then sealed.

/** Seals and opens one JSON payload. Opening never throws: a bad record is null. */
interface PayloadCipher {
    fun encrypt(value: JsonElement): ByteArray
    fun decrypt(data: ByteArray): JsonElement?

    fun encryptToBase64(value: JsonElement): String = encodeBase64(encrypt(value))

    fun decryptFromBase64(encoded: String): JsonElement? {
        val bytes = try {
            decodeBase64(encoded)
        } catch (_: IllegalArgumentException) {
            return null
        }
        return decrypt(bytes)
    }
}

internal val PayloadJson = Json

internal fun serializePayload(value: JsonElement): ByteArray =
    PayloadJson.encodeToString(JsonElement.serializer(), value).encodeToByteArray()

internal fun parsePayload(bytes: ByteArray): JsonElement? = try {
    PayloadJson.parseToJsonElement(bytes.decodeToString())
} catch (_: SerializationException) {
    null
} catch (_: IllegalArgumentException) {
    null
}

/**
 * The per-record data key format (AES256Encryption): version byte 0 ||
 * IV (12) || ciphertext || tag (16). This is the only format sessions,
 * machines and artifacts use in the current protocol.
 */
class DataKeyCipher(
    private val dataKey: ByteArray,
    private val random: RandomSource = SecureRandomSource,
) : PayloadCipher {
    init {
        require(dataKey.size == Aes256Gcm.KEY_BYTES) { "Invalid data key length" }
    }

    override fun encrypt(value: JsonElement): ByteArray =
        byteArrayOf(VERSION) + Aes256Gcm.encrypt(serializePayload(value), dataKey, random)

    override fun decrypt(data: ByteArray): JsonElement? {
        if (data.isEmpty() || data[0] != VERSION) return null
        val plaintext = Aes256Gcm.decrypt(data.copyOfRange(1, data.size), dataKey) ?: return null
        return parsePayload(plaintext)
    }

    private companion object {
        const val VERSION: Byte = 0
    }
}

/**
 * XSalsa20-Poly1305 under the account master secret (SecretBoxEncryption):
 * nonce (24) || crypto_secretbox_easy output. In the current protocol this
 * seals account settings only. Sessions and machines without their own data
 * key used it too, but that path is legacy and deliberately unsupported here.
 */
class SecretBoxCipher(
    private val secret: ByteArray,
    private val random: RandomSource = SecureRandomSource,
) : PayloadCipher {
    init {
        require(secret.size == Sodium.SECRETBOX_KEY_BYTES) { "Invalid secret length" }
    }

    override fun encrypt(value: JsonElement): ByteArray = encryptBlob(serializePayload(value), secret, random)

    override fun decrypt(data: ByteArray): JsonElement? {
        val plaintext = decryptBlob(data, secret) ?: return null
        return parsePayload(plaintext)
    }
}
