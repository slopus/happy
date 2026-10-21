package com.slopus.happy.auth

import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.security.GeneralSecurityException
import java.security.KeyStore
import java.security.NoSuchAlgorithmException
import java.security.PrivateKey
import java.util.Base64
import javax.crypto.BadPaddingException
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.NoSuchPaddingException
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/** The Android Keystore as expo-secure-store uses it. Swapped for software keys in tests. */
interface SecureStoreKeys {
    /** The AES key under [alias], or null if there is none. */
    fun secretKey(alias: String): SecretKey?

    /** AESEncryptor.initializeKeyStoreEntry: AES-256, GCM, no padding, no user authentication. */
    fun createSecretKey(alias: String): SecretKey

    /** The RSA private key under [alias] (the retired hybrid scheme), or null. */
    fun privateKey(alias: String): PrivateKey?

    fun delete(alias: String)
}

class AndroidKeyStoreKeys : SecureStoreKeys {
    private val keyStore: KeyStore by lazy { KeyStore.getInstance(PROVIDER).apply { load(null) } }

    override fun secretKey(alias: String): SecretKey? = entry<KeyStore.SecretKeyEntry>(alias)?.secretKey

    override fun createSecretKey(alias: String): SecretKey {
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, keyStore.provider)
        generator.init(
            KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setKeySize(256)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setUserAuthenticationRequired(false)
                .build(),
        )
        generator.generateKey()
        return secretKey(alias) ?: throw GeneralSecurityException("Could not retrieve the newly generated secret key entry")
    }

    override fun privateKey(alias: String): PrivateKey? = entry<KeyStore.PrivateKeyEntry>(alias)?.privateKey

    override fun delete(alias: String) = keyStore.deleteEntry(alias)

    private inline fun <reified E : KeyStore.Entry> entry(alias: String): E? {
        if (!keyStore.containsAlias(alias)) return null
        return keyStore.getEntry(alias, null) as? E
            ?: throw GeneralSecurityException("The entry for the keystore alias \"$alias\" is not a ${E::class.java.simpleName}")
    }

    private companion object {
        const val PROVIDER = "AndroidKeyStore"
    }
}

/**
 * expo-secure-store 55.0.9's Android storage (SecureStoreModule.kt,
 * AESEncryptor.kt, HybridAESEncryptor.kt), reimplemented so this app reads
 * and writes the very entries happy-app does: an upgrade from the React
 * Native build keeps the user signed in, and a rollback to it still works.
 *
 * Only what happy-app uses is supported: the default keychain service and
 * no user authentication. Layout:
 *
 *   prefs file  `SecureStore`
 *   prefs key   `<keychainService>-<key>`, i.e. `key_v1-auth_credentials`
 *               (plain `<key>` from older versions is read, and removed on write)
 *   value       JSON {ct, iv, tlen, scheme, usesKeystoreSuffix, keystoreAlias,
 *               requireAuthentication}; ct and iv base64
 *   AES key     Keystore alias `AES/GCM/NoPadding:key_v1:keystoreUnauthenticated`
 *               (without the `:keystore…` suffix when usesKeystoreSuffix is false)
 *
 * Read failures end as expo's do: no Keystore key, or a key that no longer
 * opens the value (app reinstalled), deletes the entry and reads as absent.
 */
class ExpoSecureStore(
    private val prefs: SharedPreferences,
    private val keys: SecureStoreKeys,
    /** `<package>_preferences`, which expo also clears on delete. */
    private val defaultPrefs: SharedPreferences? = null,
    private val keychainService: String = DEFAULT_KEYCHAIN_SERVICE,
) {
    /** Prefs key of [key] (createKeychainAwareKey). */
    fun prefsKey(key: String): String = "$keychainService-$key"

    /** getItemImpl / readJSONEncodedItem. Throws [GeneralSecurityException] on anything else that fails. */
    fun getItem(key: String): String? {
        val stored = prefs.getString(prefsKey(key), null) ?: prefs.getString(key, null) ?: return null
        val envelope = SecureStoreEnvelope.decode(stored) ?: throw GeneralSecurityException("Could not parse the SecureStore item for $key")
        if (envelope.requireAuthentication) {
            // Needs a biometric prompt; happy-app never stores such items.
            return null
        }
        return try {
            when (envelope.scheme) {
                SCHEME_AES -> {
                    val secretKey = keys.secretKey(aesAlias(envelope.usesKeystoreSuffix)) ?: run {
                        deleteItem(key)
                        return null
                    }
                    decrypt(envelope, secretKey)
                }
                SCHEME_HYBRID -> {
                    val privateKey = keys.privateKey(hybridAlias(envelope.usesKeystoreSuffix)) ?: return null
                    val encryptedKey = envelope.encryptedSecretKey ?: throw GeneralSecurityException("Hybrid item without a key")
                    val aesKey = rsaCipher().run {
                        init(Cipher.DECRYPT_MODE, privateKey)
                        doFinal(encryptedKey)
                    }
                    decrypt(envelope, SecretKeySpec(aesKey, "AES"))
                }
                else -> throw GeneralSecurityException("The item for key $key has an unknown encoding scheme ${envelope.scheme}")
            }
        } catch (_: KeyPermanentlyInvalidatedException) {
            null
        } catch (_: BadPaddingException) {
            // A key from a previous install: the value can never be read again.
            deleteItem(key)
            null
        }
    }

    /** setItemImpl: always the AES scheme under the suffixed alias. */
    fun setItem(key: String, value: String) {
        val alias = aesAlias(usesKeystoreSuffix = true)
        val envelope = try {
            encrypt(value, keys.secretKey(alias) ?: keys.createSecretKey(alias))
        } catch (_: KeyPermanentlyInvalidatedException) {
            keys.delete(alias)
            encrypt(value, keys.createSecretKey(alias))
        }
        if (!prefs.edit().putString(prefsKey(key), envelope.encode()).commit()) {
            throw GeneralSecurityException("Could not write $key to SecureStore")
        }
        if (prefs.contains(key)) prefs.edit().remove(key).apply()
    }

    /** deleteItemImpl. The Keystore key stays, as in expo. */
    fun deleteItem(key: String) {
        prefs.edit().remove(prefsKey(key)).remove(key).commit()
        defaultPrefs?.takeIf { it.contains(key) }?.edit()?.remove(key)?.commit()
    }

    /** AESEncryptor.getExtendedKeyStoreAlias / getKeyStoreAlias. */
    fun aesAlias(usesKeystoreSuffix: Boolean): String =
        "$AES_CIPHER:$keychainService" + if (usesKeystoreSuffix) ":$UNAUTHENTICATED_SUFFIX" else ""

    /** HybridAESEncryptor.getExtendedKeyStoreAlias / getKeyStoreAlias. */
    fun hybridAlias(usesKeystoreSuffix: Boolean): String =
        "$RSA_CIPHER:$keychainService" + if (usesKeystoreSuffix) ":$UNAUTHENTICATED_SUFFIX" else ""

    private fun encrypt(value: String, key: SecretKey): SecureStoreEnvelope {
        val cipher = Cipher.getInstance(AES_CIPHER)
        cipher.init(Cipher.ENCRYPT_MODE, key)
        val spec = cipher.parameters.getParameterSpec(GCMParameterSpec::class.java)
        return SecureStoreEnvelope(
            scheme = SCHEME_AES,
            ciphertext = cipher.doFinal(value.encodeToByteArray()),
            iv = spec.iv,
            tagLengthBits = spec.tLen,
            usesKeystoreSuffix = true,
            keystoreAlias = keychainService,
            requireAuthentication = false,
        )
    }

    private fun decrypt(envelope: SecureStoreEnvelope, key: SecretKey): String {
        if (envelope.tagLengthBits < MIN_TAG_LENGTH_BITS) {
            throw GeneralSecurityException("Authentication tag length must be at least $MIN_TAG_LENGTH_BITS bits long")
        }
        val cipher = Cipher.getInstance(AES_CIPHER)
        cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(envelope.tagLengthBits, envelope.iv))
        return cipher.doFinal(envelope.ciphertext).decodeToString()
    }

    /** expo's RSA transformation; the JVM names the same thing RSA/ECB. */
    private fun rsaCipher(): Cipher = try {
        Cipher.getInstance(RSA_CIPHER)
    } catch (_: NoSuchAlgorithmException) {
        Cipher.getInstance("RSA/ECB/PKCS1Padding")
    } catch (_: NoSuchPaddingException) {
        Cipher.getInstance("RSA/ECB/PKCS1Padding")
    }

    companion object {
        const val PREFS_NAME = "SecureStore"
        const val DEFAULT_KEYCHAIN_SERVICE = "key_v1"
        const val AES_CIPHER = "AES/GCM/NoPadding"
        const val RSA_CIPHER = "RSA/None/PKCS1Padding"
        const val UNAUTHENTICATED_SUFFIX = "keystoreUnauthenticated"
        const val SCHEME_AES = "aes"
        const val SCHEME_HYBRID = "hybrid"
        private const val MIN_TAG_LENGTH_BITS = 96
    }
}

/** One stored value, as expo-secure-store serialises it. */
class SecureStoreEnvelope(
    val scheme: String,
    val ciphertext: ByteArray,
    val iv: ByteArray,
    val tagLengthBits: Int,
    val usesKeystoreSuffix: Boolean,
    val keystoreAlias: String?,
    val requireAuthentication: Boolean,
    /** `esk`: the hybrid scheme's RSA-wrapped AES key. */
    val encryptedSecretKey: ByteArray? = null,
) {
    /** Same fields in the same order as expo writes them; base64 without line breaks (NO_WRAP). */
    fun encode(): String = buildJsonObject {
        put(CT, Base64.getEncoder().encodeToString(ciphertext))
        put(IV, Base64.getEncoder().encodeToString(iv))
        put(TLEN, tagLengthBits)
        put(SCHEME, scheme)
        put(USES_KEYSTORE_SUFFIX, usesKeystoreSuffix)
        if (keystoreAlias != null) put(KEYSTORE_ALIAS, keystoreAlias)
        put(REQUIRE_AUTHENTICATION, requireAuthentication)
        if (encryptedSecretKey != null) put(ESK, Base64.getEncoder().encodeToString(encryptedSecretKey))
    }.toString()

    companion object {
        const val CT = "ct"
        const val IV = "iv"
        const val TLEN = "tlen"
        const val SCHEME = "scheme"
        const val USES_KEYSTORE_SUFFIX = "usesKeystoreSuffix"
        const val KEYSTORE_ALIAS = "keystoreAlias"
        const val REQUIRE_AUTHENTICATION = "requireAuthentication"
        const val ESK = "esk"

        /** Null if [text] is not an envelope. Base64 is read like android.util.Base64.DEFAULT: line breaks allowed. */
        fun decode(text: String): SecureStoreEnvelope? = try {
            val json = Json.parseToJsonElement(text).jsonObject
            fun string(name: String): String? = (json[name] as? JsonPrimitive)?.content
            fun flag(name: String): Boolean = string(name).toBoolean()
            fun bytes(name: String): ByteArray? = string(name)?.let { Base64.getMimeDecoder().decode(it) }
            SecureStoreEnvelope(
                scheme = string(SCHEME)?.takeIf { it.isNotEmpty() } ?: return null,
                ciphertext = bytes(CT) ?: return null,
                iv = bytes(IV) ?: return null,
                tagLengthBits = json[TLEN]?.jsonPrimitive?.int ?: return null,
                usesKeystoreSuffix = flag(USES_KEYSTORE_SUFFIX),
                keystoreAlias = string(KEYSTORE_ALIAS),
                requireAuthentication = flag(REQUIRE_AUTHENTICATION),
                encryptedSecretKey = bytes(ESK),
            )
        } catch (_: IllegalArgumentException) {
            // Malformed JSON (SerializationException), base64 or numbers.
            null
        }
    }
}
