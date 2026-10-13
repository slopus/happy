package com.slopus.happy.auth

import android.util.Log
import com.slopus.happy.crypto.Base64Variant
import com.slopus.happy.crypto.decodeBase64
import com.slopus.happy.net.HappyJson
import kotlinx.serialization.Serializable
import java.security.GeneralSecurityException

/**
 * What happy-app keeps under `auth_credentials`: the server token and the
 * 32-byte account secret as base64url. Encoded exactly as tokenStorage.ts
 * writes it, `JSON.stringify({ token, secret })`.
 */
@Serializable
data class AuthCredentials(val token: String, val secret: String) {
    fun secretBytes(): ByteArray = decodeBase64(secret, Base64Variant.Url)
}

/** Where the signed-in account is kept. */
interface CredentialStore {
    fun read(): AuthCredentials?
    fun write(credentials: AuthCredentials)
    fun clear()
}

/**
 * tokenStorage.ts on Android: the credentials live in expo-secure-store, in
 * the same entry the React Native build uses. A value that cannot be read
 * or parsed reads as signed out and is left alone, as tokenStorage.ts does.
 */
class SecureStoreCredentialStore(private val secureStore: ExpoSecureStore) : CredentialStore {
    override fun read(): AuthCredentials? = try {
        secureStore.getItem(KEY)?.let { HappyJson.decodeFromString(AuthCredentials.serializer(), it) }
    } catch (e: GeneralSecurityException) {
        Log.w(TAG, "Could not read credentials", e)
        null
    } catch (e: IllegalArgumentException) {
        Log.w(TAG, "Could not parse credentials", e)
        null
    }

    override fun write(credentials: AuthCredentials) {
        secureStore.setItem(KEY, HappyJson.encodeToString(AuthCredentials.serializer(), credentials))
    }

    override fun clear() = secureStore.deleteItem(KEY)

    companion object {
        /** tokenStorage.ts AUTH_KEY */
        const val KEY = "auth_credentials"
        private const val TAG = "CredentialStore"
    }
}
