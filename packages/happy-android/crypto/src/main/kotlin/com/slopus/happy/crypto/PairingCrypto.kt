package com.slopus.happy.crypto

import org.bouncycastle.crypto.digests.SHA256Digest
import org.bouncycastle.crypto.generators.HKDFBytesGenerator
import org.bouncycastle.crypto.macs.HMac
import org.bouncycastle.crypto.params.HKDFParameters
import org.bouncycastle.crypto.params.KeyParameter
import java.security.MessageDigest

// Happy Protocol V2 pairing: happy-agent API.md, "Mobile connector" › "Pairing".
// The phone's half of the key exchange, checked against API.md's vectors.

fun sha256(data: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(data)

fun hmacSha256(key: ByteArray, data: ByteArray): ByteArray {
    val mac = HMac(SHA256Digest())
    mac.init(KeyParameter(key))
    mac.update(data, 0, data.size)
    return ByteArray(mac.macSize).also { mac.doFinal(it, 0) }
}

/** HKDF-SHA-256, extract then expand. */
fun hkdfSha256(ikm: ByteArray, salt: ByteArray, info: ByteArray, length: Int): ByteArray {
    val generator = HKDFBytesGenerator(SHA256Digest())
    generator.init(HKDFParameters(ikm, salt, info))
    return ByteArray(length).also { generator.generateBytes(it, 0, length) }
}

/**
 * API.md "Encoding": base64url without padding, in canonical form only. A
 * text that doesn't decode to bytes which encode back to exactly it is
 * refused, so one value has one spelling.
 */
object CanonicalBase64Url {
    private val alphabet = Regex("^[A-Za-z0-9_-]+$")

    fun encode(bytes: ByteArray): String = encodeBase64(bytes, Base64Variant.Url)

    fun decode(text: String): ByteArray? {
        if (text.isEmpty() || !alphabet.matches(text)) return null
        val bytes = try {
            decodeBase64(text, Base64Variant.Url)
        } catch (_: IllegalArgumentException) {
            return null
        }
        return bytes.takeIf { encode(it) == text }
    }
}

/**
 * The phone's key pair, nonce and commitment for one pairing. The device
 * token is derived on both sides and never sent while pairing.
 */
class PairingCrypto(
    privateKey: ByteArray? = null,
    nonce: ByteArray? = null,
    random: RandomSource = SecureRandomSource,
) {
    private val privateKey: ByteArray = privateKey?.copyOf() ?: random.nextBytes(32)
    val publicKey: ByteArray
    val nonce: ByteArray = nonce?.copyOf() ?: random.nextBytes(32)
    val commitment: ByteArray

    init {
        require(this.privateKey.size == 32) { "pairing key" }
        require(this.nonce.size == 32) { "pairing nonce" }
        publicKey = Sodium.scalarMultBase(this.privateKey)
        commitment = sha256(utf8("$LABEL/commit") + publicKey + this.nonce)
    }

    /** What both sides derive once the daemon's key and nonce are known. */
    class Secrets(
        val transcriptHash: ByteArray,
        val emojiKey: ByteArray,
        val confirmKey: ByteArray,
        val deviceToken: ByteArray,
    ) {
        val emoji: List<String> get() = emoji(sha256(emojiKey))

        /** `MAC(role) = HMAC-SHA256(confirmKey, role ‖ TH)`. */
        fun mac(role: String): ByteArray = hmacSha256(confirmKey, utf8(role) + transcriptHash)

        /** The daemon's `MAC("daemon")`, compared in constant time. */
        fun verifyDaemon(proof: ByteArray): Boolean = MessageDigest.isEqual(proof, mac("daemon"))
    }

    /**
     * Null when the daemon's key or nonce is unusable: a wrong length, or a
     * low-order key whose shared secret is all zeros.
     */
    fun derive(daemonPublicKey: ByteArray, daemonNonce: ByteArray, token: ByteArray, address: String, port: Int): Secrets? {
        if (daemonPublicKey.size != 32 || daemonNonce.size != 32 || token.size != 32 || port !in 1..65535) return null
        val shared = Sodium.scalarMult(privateKey, daemonPublicKey) ?: return null
        if (shared.all { it == 0.toByte() }) return null
        val fields = listOf(
            token, commitment, publicKey, daemonPublicKey, nonce, daemonNonce, utf8(address),
            byteArrayOf((port shr 8).toByte(), (port and 0xff).toByte()),
        )
        var transcript = utf8(LABEL)
        for (field in fields) transcript += lengthPrefix(field.size) + field
        val hash = sha256(transcript)
        fun expand(purpose: String) = hkdfSha256(shared, salt = hash, info = utf8("$LABEL $purpose"), length = 32)
        return Secrets(hash, expand("emoji"), expand("confirm"), expand("device-token"))
    }

    companion object {
        const val LABEL = "happy-mobile-pair-v1"

        /** API.md "The emoji table": Telegram iOS's 333, exactly as listed there. */
        val emojiTable: List<String> by lazy {
            val stream = PairingCrypto::class.java.getResourceAsStream("/pairing/emoji.txt")
                ?: error("Missing the pairing emoji table")
            stream.use { it.readBytes().toString(Charsets.UTF_8) }.split('\n')
        }

        /**
         * `stringForEmojiHashOfData(hash, 4)`: each 8 bytes big-endian, top
         * bit cleared, modulo the table's length.
         */
        fun emoji(hash: ByteArray): List<String> {
            if (hash.size != 32) return emptyList()
            val table = emojiTable
            return (0 until 4).map { index ->
                var value = 0L
                for (i in 0 until 8) value = (value shl 8) or (hash[index * 8 + i].toLong() and 0xff)
                value = value and Long.MAX_VALUE
                table[(value % table.size).toInt()]
            }
        }

        private fun utf8(text: String) = text.toByteArray(Charsets.UTF_8)

        private fun lengthPrefix(count: Int) = byteArrayOf(
            (count ushr 24).toByte(), (count ushr 16).toByte(), (count ushr 8).toByte(), count.toByte(),
        )
    }
}
