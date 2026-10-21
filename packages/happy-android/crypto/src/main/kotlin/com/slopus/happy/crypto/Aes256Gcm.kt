package com.slopus.happy.crypto

import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * AES-256-GCM with a 12-byte random IV, as rn-encryption, aes.web.ts and the
 * CLI's encryptWithDataKey produce it. Layout: IV (12) || ciphertext || tag (16).
 * The version byte is added by [DataKeyCipher], not here.
 */
object Aes256Gcm {
    const val KEY_BYTES = 32
    const val IV_BYTES = 12
    const val TAG_BYTES = 16

    fun encrypt(plaintext: ByteArray, key: ByteArray, random: RandomSource = SecureRandomSource): ByteArray {
        require(key.size == KEY_BYTES) { "Invalid key length" }
        val iv = random.nextBytes(IV_BYTES)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_BYTES * 8, iv))
        return iv + cipher.doFinal(plaintext)
    }

    /** Null when the input is too short, the key is wrong, or the tag does not verify. */
    fun decrypt(bundle: ByteArray, key: ByteArray): ByteArray? {
        if (key.size != KEY_BYTES || bundle.size < IV_BYTES + TAG_BYTES) return null
        return try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(
                Cipher.DECRYPT_MODE,
                SecretKeySpec(key, "AES"),
                GCMParameterSpec(TAG_BYTES * 8, bundle, 0, IV_BYTES),
            )
            cipher.doFinal(bundle, IV_BYTES, bundle.size - IV_BYTES)
        } catch (_: java.security.GeneralSecurityException) {
            null
        }
    }
}
