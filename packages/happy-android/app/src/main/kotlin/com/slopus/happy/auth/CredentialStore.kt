package com.slopus.happy.auth

import android.util.Log
import com.slopus.happy.crypto.Base64Variant
import com.slopus.happy.crypto.decodeBase64
import com.slopus.happy.net.HappyJson
import kotlinx.serialization.Serializable

/**
 * What happy-app keeps under `auth_credentials`: the server token and the
 * 32-byte account secret as base64url. Encoded exactly as tokenStorage.ts
 * writes it, `JSON.stringify({ token, secret })`.
 */
@Serializable
data class AuthCredentials(val token: String, val secret: String) {
    fun secretBytes(): ByteArray = decodeBase64(secret, Base64Variant.Url)
}

/** Why [SecureStoreCredentialStore] read its item as signed out. */
sealed interface UnreadableCredentials {
    data class Item(val reason: UnreadableItem) : UnreadableCredentials
    /** The read threw: the Keystore, or anything else. */
    data object Failed : UnreadableCredentials
    /** It opened, but isn't `{token, secret}`. */
    data object Invalid : UnreadableCredentials
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
 * or parsed reads as signed out and is left alone, as tokenStorage.ts does:
 * expo rejects every failure of a read, a Keystore error included, and
 * tokenStorage.ts catches it. [unreadable] is told why.
 */
class SecureStoreCredentialStore(
    private val secureStore: ExpoSecureStore,
    private val unreadable: (UnreadableCredentials) -> Unit = {},
) : CredentialStore {
    override fun read(): AuthCredentials? {
        var why: UnreadableItem? = null
        val stored = try {
            secureStore.getItem(KEY) { why = it }
        } catch (e: Exception) {
            Log.w(TAG, "Could not read credentials", e)
            unreadable(why?.let(UnreadableCredentials::Item) ?: UnreadableCredentials.Failed)
            return null
        }
        why?.let { unreadable(UnreadableCredentials.Item(it)) }
        return try {
            stored?.let { HappyJson.decodeFromString(AuthCredentials.serializer(), it) }
        } catch (e: IllegalArgumentException) {
            Log.w(TAG, "Could not parse credentials", e)
            unreadable(UnreadableCredentials.Invalid)
            null
        }
    }

    /** Whether the credential item is there, readable or not. */
    fun isStored(): Boolean = secureStore.contains(KEY)

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
