package com.slopus.happy.crypto

import org.bouncycastle.crypto.engines.XSalsa20Engine
import org.bouncycastle.crypto.macs.Poly1305
import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import org.bouncycastle.crypto.params.Ed25519PublicKeyParameters
import org.bouncycastle.crypto.params.KeyParameter
import org.bouncycastle.crypto.params.ParametersWithIV
import org.bouncycastle.crypto.signers.Ed25519Signer
import org.bouncycastle.math.ec.rfc7748.X25519
import java.security.MessageDigest

/**
 * The libsodium functions happy-app calls, with libsodium's exact byte layouts.
 *
 * Built from BouncyCastle's low-level primitives (no JCA provider), so the
 * same code runs on Android and on the host JVM in unit tests.
 */
object Sodium {
    const val SIGN_SEED_BYTES = 32
    const val SIGN_PUBLIC_KEY_BYTES = 32
    const val SIGN_SECRET_KEY_BYTES = 64
    const val SIGN_BYTES = 64

    const val BOX_SEED_BYTES = 32
    const val BOX_PUBLIC_KEY_BYTES = 32
    const val BOX_SECRET_KEY_BYTES = 32
    const val BOX_NONCE_BYTES = 24
    const val BOX_MAC_BYTES = 16

    const val SECRETBOX_KEY_BYTES = 32
    const val SECRETBOX_NONCE_BYTES = 24
    const val SECRETBOX_MAC_BYTES = 16

    class KeyPair(val publicKey: ByteArray, val secretKey: ByteArray)

    //
    // Ed25519 (crypto_sign_*)
    //

    /** crypto_sign_seed_keypair: the secret key is seed || publicKey, 64 bytes. */
    fun signSeedKeypair(seed: ByteArray): KeyPair {
        require(seed.size == SIGN_SEED_BYTES) { "Invalid seed length" }
        val publicKey = Ed25519PrivateKeyParameters(seed, 0).generatePublicKey().encoded
        return KeyPair(publicKey = publicKey, secretKey = seed + publicKey)
    }

    fun signDetached(message: ByteArray, secretKey: ByteArray): ByteArray {
        require(secretKey.size == SIGN_SECRET_KEY_BYTES) { "Invalid secret key length" }
        val signer = Ed25519Signer()
        signer.init(true, Ed25519PrivateKeyParameters(secretKey, 0))
        signer.update(message, 0, message.size)
        return signer.generateSignature()
    }

    fun signVerifyDetached(signature: ByteArray, message: ByteArray, publicKey: ByteArray): Boolean {
        if (signature.size != SIGN_BYTES || publicKey.size != SIGN_PUBLIC_KEY_BYTES) return false
        val verifier = Ed25519Signer()
        verifier.init(false, Ed25519PublicKeyParameters(publicKey, 0))
        verifier.update(message, 0, message.size)
        return verifier.verifySignature(signature)
    }

    //
    // X25519 (crypto_box_*keypair, crypto_scalarmult)
    //

    /** crypto_box_seed_keypair: secretKey = SHA-512(seed)[0, 32), publicKey = X25519 base point multiple. */
    fun boxSeedKeypair(seed: ByteArray): KeyPair {
        require(seed.size == BOX_SEED_BYTES) { "Invalid seed length" }
        val secretKey = MessageDigest.getInstance("SHA-512").digest(seed).copyOfRange(0, BOX_SECRET_KEY_BYTES)
        return KeyPair(publicKey = scalarMultBase(secretKey), secretKey = secretKey)
    }

    /** crypto_box_keypair: 32 random bytes are the secret key. */
    fun boxKeypair(random: RandomSource = SecureRandomSource): KeyPair {
        val secretKey = random.nextBytes(BOX_SECRET_KEY_BYTES)
        return KeyPair(publicKey = scalarMultBase(secretKey), secretKey = secretKey)
    }

    fun scalarMultBase(secretKey: ByteArray): ByteArray {
        require(secretKey.size == BOX_SECRET_KEY_BYTES) { "Invalid secret key length" }
        val out = ByteArray(BOX_PUBLIC_KEY_BYTES)
        X25519.scalarMultBase(secretKey, 0, out, 0)
        return out
    }

    /** crypto_scalarmult. Null when the result is all zeros (a low-order public key), as libsodium fails. */
    fun scalarMult(secretKey: ByteArray, publicKey: ByteArray): ByteArray? {
        if (secretKey.size != BOX_SECRET_KEY_BYTES || publicKey.size != BOX_PUBLIC_KEY_BYTES) return null
        val out = ByteArray(32)
        return if (X25519.calculateAgreement(secretKey, 0, publicKey, 0, out, 0)) out else null
    }

    //
    // crypto_box (Curve25519-XSalsa20-Poly1305)
    //

    /** crypto_box_beforenm: HSalsa20(X25519(sk, pk), 0^16). */
    fun boxBeforeNm(publicKey: ByteArray, secretKey: ByteArray): ByteArray? {
        val shared = scalarMult(secretKey, publicKey) ?: return null
        return hsalsa20(shared, ByteArray(16))
    }

    /** crypto_box_easy: MAC (16) || ciphertext. Null if the public key is unusable. */
    fun boxEasy(message: ByteArray, nonce: ByteArray, publicKey: ByteArray, secretKey: ByteArray): ByteArray? {
        val key = boxBeforeNm(publicKey, secretKey) ?: return null
        return secretboxEasy(message, nonce, key)
    }

    fun boxOpenEasy(ciphertext: ByteArray, nonce: ByteArray, publicKey: ByteArray, secretKey: ByteArray): ByteArray? {
        val key = boxBeforeNm(publicKey, secretKey) ?: return null
        return secretboxOpenEasy(ciphertext, nonce, key)
    }

    //
    // crypto_secretbox (XSalsa20-Poly1305)
    //

    /** crypto_secretbox_easy: MAC (16) || ciphertext. */
    fun secretboxEasy(message: ByteArray, nonce: ByteArray, key: ByteArray): ByteArray {
        require(nonce.size == SECRETBOX_NONCE_BYTES) { "Invalid nonce length" }
        require(key.size == SECRETBOX_KEY_BYTES) { "Invalid key length" }
        val stream = xsalsa20(key, nonce)
        val macKey = ByteArray(32).also { stream.processBytes(ByteArray(32), 0, 32, it, 0) }
        val out = ByteArray(SECRETBOX_MAC_BYTES + message.size)
        stream.processBytes(message, 0, message.size, out, SECRETBOX_MAC_BYTES)
        poly1305(macKey, out, SECRETBOX_MAC_BYTES, message.size).copyInto(out, 0)
        return out
    }

    /** Null when the input is too short or fails authentication. */
    fun secretboxOpenEasy(ciphertext: ByteArray, nonce: ByteArray, key: ByteArray): ByteArray? {
        if (nonce.size != SECRETBOX_NONCE_BYTES || key.size != SECRETBOX_KEY_BYTES) return null
        if (ciphertext.size < SECRETBOX_MAC_BYTES) return null
        val stream = xsalsa20(key, nonce)
        val macKey = ByteArray(32).also { stream.processBytes(ByteArray(32), 0, 32, it, 0) }
        val bodyLength = ciphertext.size - SECRETBOX_MAC_BYTES
        val expected = poly1305(macKey, ciphertext, SECRETBOX_MAC_BYTES, bodyLength)
        if (!MessageDigest.isEqual(expected, ciphertext.copyOfRange(0, SECRETBOX_MAC_BYTES))) return null
        val out = ByteArray(bodyLength)
        stream.processBytes(ciphertext, SECRETBOX_MAC_BYTES, bodyLength, out, 0)
        return out
    }

    private fun xsalsa20(key: ByteArray, nonce: ByteArray): XSalsa20Engine =
        XSalsa20Engine().apply { init(true, ParametersWithIV(KeyParameter(key), nonce)) }

    private fun poly1305(key: ByteArray, data: ByteArray, offset: Int, length: Int): ByteArray {
        val mac = Poly1305()
        mac.init(KeyParameter(key))
        mac.update(data, offset, length)
        return ByteArray(16).also { mac.doFinal(it, 0) }
    }

    /**
     * HSalsa20 core (crypto_core_hsalsa20 with the default "expand 32-byte k"
     * constants). BouncyCastle runs it inside XSalsa20Engine but does not
     * expose it, and crypto_box needs it on its own.
     */
    internal fun hsalsa20(key: ByteArray, input: ByteArray): ByteArray {
        require(key.size == 32 && input.size == 16)
        val x = IntArray(16)
        x[0] = 0x61707865
        x[5] = 0x3320646e
        x[10] = 0x79622d32
        x[15] = 0x6b206574
        for (i in 0 until 4) {
            x[1 + i] = littleEndianInt(key, i * 4)
            x[11 + i] = littleEndianInt(key, 16 + i * 4)
            x[6 + i] = littleEndianInt(input, i * 4)
        }
        repeat(10) {
            // Column round
            x[4] = x[4] xor Integer.rotateLeft(x[0] + x[12], 7)
            x[8] = x[8] xor Integer.rotateLeft(x[4] + x[0], 9)
            x[12] = x[12] xor Integer.rotateLeft(x[8] + x[4], 13)
            x[0] = x[0] xor Integer.rotateLeft(x[12] + x[8], 18)
            x[9] = x[9] xor Integer.rotateLeft(x[5] + x[1], 7)
            x[13] = x[13] xor Integer.rotateLeft(x[9] + x[5], 9)
            x[1] = x[1] xor Integer.rotateLeft(x[13] + x[9], 13)
            x[5] = x[5] xor Integer.rotateLeft(x[1] + x[13], 18)
            x[14] = x[14] xor Integer.rotateLeft(x[10] + x[6], 7)
            x[2] = x[2] xor Integer.rotateLeft(x[14] + x[10], 9)
            x[6] = x[6] xor Integer.rotateLeft(x[2] + x[14], 13)
            x[10] = x[10] xor Integer.rotateLeft(x[6] + x[2], 18)
            x[3] = x[3] xor Integer.rotateLeft(x[15] + x[11], 7)
            x[7] = x[7] xor Integer.rotateLeft(x[3] + x[15], 9)
            x[11] = x[11] xor Integer.rotateLeft(x[7] + x[3], 13)
            x[15] = x[15] xor Integer.rotateLeft(x[11] + x[7], 18)
            // Row round
            x[1] = x[1] xor Integer.rotateLeft(x[0] + x[3], 7)
            x[2] = x[2] xor Integer.rotateLeft(x[1] + x[0], 9)
            x[3] = x[3] xor Integer.rotateLeft(x[2] + x[1], 13)
            x[0] = x[0] xor Integer.rotateLeft(x[3] + x[2], 18)
            x[6] = x[6] xor Integer.rotateLeft(x[5] + x[4], 7)
            x[7] = x[7] xor Integer.rotateLeft(x[6] + x[5], 9)
            x[4] = x[4] xor Integer.rotateLeft(x[7] + x[6], 13)
            x[5] = x[5] xor Integer.rotateLeft(x[4] + x[7], 18)
            x[11] = x[11] xor Integer.rotateLeft(x[10] + x[9], 7)
            x[8] = x[8] xor Integer.rotateLeft(x[11] + x[10], 9)
            x[9] = x[9] xor Integer.rotateLeft(x[8] + x[11], 13)
            x[10] = x[10] xor Integer.rotateLeft(x[9] + x[8], 18)
            x[12] = x[12] xor Integer.rotateLeft(x[15] + x[14], 7)
            x[13] = x[13] xor Integer.rotateLeft(x[12] + x[15], 9)
            x[14] = x[14] xor Integer.rotateLeft(x[13] + x[12], 13)
            x[15] = x[15] xor Integer.rotateLeft(x[14] + x[13], 18)
        }
        val out = ByteArray(32)
        intArrayOf(x[0], x[5], x[10], x[15], x[6], x[7], x[8], x[9]).forEachIndexed { i, word ->
            putLittleEndianInt(word, out, i * 4)
        }
        return out
    }

    private fun littleEndianInt(bytes: ByteArray, offset: Int): Int =
        (bytes[offset].toInt() and 0xff) or
            ((bytes[offset + 1].toInt() and 0xff) shl 8) or
            ((bytes[offset + 2].toInt() and 0xff) shl 16) or
            ((bytes[offset + 3].toInt() and 0xff) shl 24)

    private fun putLittleEndianInt(value: Int, out: ByteArray, offset: Int) {
        out[offset] = value.toByte()
        out[offset + 1] = (value ushr 8).toByte()
        out[offset + 2] = (value ushr 16).toByte()
        out[offset + 3] = (value ushr 24).toByte()
    }
}
