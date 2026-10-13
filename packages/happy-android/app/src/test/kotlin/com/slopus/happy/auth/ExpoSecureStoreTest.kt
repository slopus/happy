package com.slopus.happy.auth

import android.content.Context
import android.content.SharedPreferences
import android.util.Base64
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.testing.SoftwareKeys
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.nio.charset.StandardCharsets
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * expo-secure-store 55.0.9 compatibility. [Expo] below is the read and
 * write path of expo's SecureStoreModule.kt / AESEncryptor.kt, copied with
 * android.util.Base64 and org.json as expo uses them (real implementations
 * under Robolectric), so values cross between the two in both directions.
 */
@RunWith(AndroidJUnit4::class)
class ExpoSecureStoreTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private lateinit var prefs: SharedPreferences
    private lateinit var defaultPrefs: SharedPreferences
    private lateinit var keys: SoftwareKeys
    private lateinit var store: ExpoSecureStore

    @Before
    fun setUp() {
        prefs = context.getSharedPreferences("SecureStore", Context.MODE_PRIVATE).also { it.edit().clear().commit() }
        defaultPrefs = context.getSharedPreferences("${context.packageName}_preferences", Context.MODE_PRIVATE)
            .also { it.edit().clear().commit() }
        keys = SoftwareKeys()
        store = ExpoSecureStore(prefs, keys, defaultPrefs)
    }

    @Test
    fun namesMatchExpo() {
        assertEquals("SecureStore", ExpoSecureStore.PREFS_NAME)
        assertEquals("key_v1-auth_credentials", store.prefsKey("auth_credentials"))
        assertEquals("AES/GCM/NoPadding:key_v1:keystoreUnauthenticated", store.aesAlias(usesKeystoreSuffix = true))
        assertEquals("AES/GCM/NoPadding:key_v1", store.aesAlias(usesKeystoreSuffix = false))
        assertEquals("RSA/None/PKCS1Padding:key_v1:keystoreUnauthenticated", store.hybridAlias(usesKeystoreSuffix = true))
        assertEquals("RSA/None/PKCS1Padding:key_v1", store.hybridAlias(usesKeystoreSuffix = false))
    }

    @Test
    fun writesExposEnvelope() {
        store.setItem("auth_credentials", "hello")
        val stored = prefs.getString("key_v1-auth_credentials", null)!!
        val json = JSONObject(stored)
        assertEquals(listOf("ct", "iv", "tlen", "scheme", "usesKeystoreSuffix", "keystoreAlias", "requireAuthentication"), json.keys().asSequence().toList())
        assertEquals("aes", json.getString("scheme"))
        assertEquals(128, json.getInt("tlen"))
        assertEquals(12, Base64.decode(json.getString("iv"), Base64.DEFAULT).size)
        assertEquals("5 bytes + 16 tag", 21, Base64.decode(json.getString("ct"), Base64.DEFAULT).size)
        assertTrue(json.getBoolean("usesKeystoreSuffix"))
        assertEquals("key_v1", json.getString("keystoreAlias"))
        assertFalse(json.getBoolean("requireAuthentication"))
        assertFalse("NO_WRAP base64", stored.contains("\\n"))
        assertEquals(setOf("AES/GCM/NoPadding:key_v1:keystoreUnauthenticated"), keys.secretKeys.keys)
    }

    @Test
    fun readsWhatExpoWrites() {
        val key = keys.createSecretKey("AES/GCM/NoPadding:key_v1:keystoreUnauthenticated")
        Expo.setItem(prefs, "auth_credentials", """{"token":"t","secret":"s"}""", key)
        assertEquals("""{"token":"t","secret":"s"}""", store.getItem("auth_credentials"))
    }

    @Test
    fun expoReadsWhatThisWrites() {
        store.setItem("auth_credentials", """{"token":"t","secret":"s"}""")
        val key = keys.secretKey("AES/GCM/NoPadding:key_v1:keystoreUnauthenticated")!!
        assertEquals("""{"token":"t","secret":"s"}""", Expo.getItem(prefs, "auth_credentials", key))
    }

    @Test
    fun readsTheUnprefixedKeyAndUnsuffixedAliasOfOlderVersions() {
        val legacyKey = keys.createSecretKey("AES/GCM/NoPadding:key_v1")
        val envelope = Expo.encrypt("old", legacyKey).put("scheme", "aes")
        prefs.edit().putString("auth_credentials", envelope.toString()).commit()
        assertEquals("old", store.getItem("auth_credentials"))

        // Writing moves it to the current key and alias and drops the old entry.
        store.setItem("auth_credentials", "new")
        assertFalse(prefs.contains("auth_credentials"))
        assertEquals("new", store.getItem("auth_credentials"))
        assertTrue(JSONObject(prefs.getString("key_v1-auth_credentials", null)!!).getBoolean("usesKeystoreSuffix"))
    }

    @Test
    fun readsTheHybridScheme() {
        val pair = keys.createKeyPair("RSA/None/PKCS1Padding:key_v1")
        val aesKey = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
        val rsa = Cipher.getInstance("RSA/ECB/PKCS1Padding").apply { init(Cipher.ENCRYPT_MODE, pair.public) }
        val envelope = Expo.encrypt("from android 5", aesKey)
            .put("scheme", "hybrid")
            .put("esk", Base64.encodeToString(rsa.doFinal(aesKey.encoded), Base64.DEFAULT))
        prefs.edit().putString("key_v1-auth_credentials", envelope.toString()).commit()
        assertEquals("from android 5", store.getItem("auth_credentials"))
    }

    @Test
    fun aMissingKeystoreKeyDeletesTheEntryLikeExpo() {
        store.setItem("auth_credentials", "x")
        keys.secretKeys.clear()
        assertNull(store.getItem("auth_credentials"))
        assertFalse(prefs.contains("key_v1-auth_credentials"))
    }

    @Test
    fun aKeyFromAnotherInstallDeletesTheEntryLikeExpo() {
        store.setItem("auth_credentials", "x")
        keys.secretKeys["AES/GCM/NoPadding:key_v1:keystoreUnauthenticated"] = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
        assertNull(store.getItem("auth_credentials"))
        assertFalse(prefs.contains("key_v1-auth_credentials"))
    }

    @Test
    fun deleteClearsEveryPlaceExpoDoes() {
        store.setItem("auth_credentials", "x")
        prefs.edit().putString("auth_credentials", "legacy").commit()
        defaultPrefs.edit().putString("auth_credentials", "older").commit()
        store.deleteItem("auth_credentials")
        assertTrue(prefs.all.isEmpty())
        assertFalse(defaultPrefs.contains("auth_credentials"))
        assertNull(store.getItem("auth_credentials"))
    }

    @Test
    fun envelopeRoundTripAndWrappedBase64() {
        val envelope = SecureStoreEnvelope("aes", byteArrayOf(1, 2, 3), ByteArray(12) { it.toByte() }, 128, true, "key_v1", false)
        val decoded = SecureStoreEnvelope.decode(envelope.encode())!!
        assertArrayEquals(envelope.ciphertext, decoded.ciphertext)
        assertArrayEquals(envelope.iv, decoded.iv)
        assertEquals(128, decoded.tagLengthBits)
        assertTrue(decoded.usesKeystoreSuffix)
        // android.util.Base64.DEFAULT wraps at 76 characters and org.json escapes '/'; both must read.
        val long = ByteArray(200) { (it * 31).toByte() }
        val wrapped = JSONObject()
            .put("ct", Base64.encodeToString(long, Base64.DEFAULT))
            .put("iv", Base64.encodeToString(ByteArray(12), Base64.DEFAULT))
            .put("tlen", 128)
            .put("scheme", "aes")
        assertArrayEquals(long, SecureStoreEnvelope.decode(wrapped.toString())!!.ciphertext)
        assertNull(SecureStoreEnvelope.decode("not json"))
        assertNull(SecureStoreEnvelope.decode("""{"ct":"AA==","iv":"AA==","tlen":128}"""))
    }

    @Test
    fun credentialsJsonIsWhatTokenStorageWrites() {
        val credentials = SecureStoreCredentialStore(store)
        // JSON.stringify({ token, secret })
        store.setItem("auth_credentials", """{"token":"tok","secret":"c2VjcmV0"}""")
        assertEquals(AuthCredentials("tok", "c2VjcmV0"), credentials.read())

        credentials.write(AuthCredentials("tok2", "c2Vj"))
        assertEquals("""{"token":"tok2","secret":"c2Vj"}""", store.getItem("auth_credentials"))

        credentials.clear()
        assertNull(credentials.read())
    }

    @Test
    fun unparseableCredentialsReadAsSignedOutAndStay() {
        store.setItem("auth_credentials", "{not json")
        assertNull(SecureStoreCredentialStore(store).read())
        assertTrue(prefs.contains("key_v1-auth_credentials"))
    }

    /** expo-secure-store's own code paths (AESEncryptor / SecureStoreModule), for the default options. */
    private object Expo {
        fun encrypt(value: String, key: SecretKey): JSONObject {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, key)
            val gcmSpec = cipher.parameters.getParameterSpec(GCMParameterSpec::class.java)
            val ciphertextBytes = cipher.doFinal(value.toByteArray(StandardCharsets.UTF_8))
            return JSONObject()
                .put("ct", Base64.encodeToString(ciphertextBytes, Base64.NO_WRAP))
                .put("iv", Base64.encodeToString(gcmSpec.iv, Base64.NO_WRAP))
                .put("tlen", gcmSpec.tLen)
        }

        fun setItem(prefs: SharedPreferences, key: String, value: String, secretKey: SecretKey) {
            val item = encrypt(value, secretKey)
            item.put("scheme", "aes")
            item.put("usesKeystoreSuffix", true)
            item.put("keystoreAlias", "key_v1")
            item.put("requireAuthentication", false)
            prefs.edit().putString("key_v1-$key", item.toString()).commit()
        }

        fun getItem(prefs: SharedPreferences, key: String, secretKey: SecretKey): String {
            val item = JSONObject(prefs.getString("key_v1-$key", null)!!)
            check(item.optString("scheme") == "aes")
            check(item.optBoolean("usesKeystoreSuffix", false))
            check(!item.optBoolean("requireAuthentication", false))
            val gcmSpec = GCMParameterSpec(item.getInt("tlen"), Base64.decode(item.getString("iv"), Base64.DEFAULT))
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, secretKey, gcmSpec)
            return String(cipher.doFinal(Base64.decode(item.getString("ct"), Base64.DEFAULT)), StandardCharsets.UTF_8)
        }
    }
}
