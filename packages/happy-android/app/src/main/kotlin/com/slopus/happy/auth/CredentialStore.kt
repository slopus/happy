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

/** Why a credential item is there but can't be read. */
sealed interface UnreadableCredentials {
    data class Item(val reason: UnreadableItem) : UnreadableCredentials
    /** The read threw, every try: the Keystore, or anything else. */
    data class Failed(val error: Exception) : UnreadableCredentials
    /** It opened, but isn't the account it should be (not `{token, secret}`, or not a 32-byte secret). */
    data object Invalid : UnreadableCredentials
}

/** What a credential item holds: nothing, an account's [value], or an item that is there but can't be read. */
sealed interface Stored<out T> {
    data object Absent : Stored<Nothing>
    data class Present<T>(val value: T) : Stored<T>
    /** Not signed out: the account is still on the phone, and nothing may write over or clear it. */
    data class Unreadable(val reason: UnreadableCredentials) : Stored<Nothing>

    fun presentOrNull(): T? = (this as? Present<T>)?.value
}

/** Where the signed-in account is kept. */
interface CredentialStore {
    fun read(): AuthCredentials?
    /** [read], telling an item that isn't there from one that can't be read. */
    fun load(): Stored<AuthCredentials> = read()?.let { Stored.Present(it) } ?: Stored.Absent
    fun write(credentials: AuthCredentials)
    fun clear()
}

/**
 * tokenStorage.ts on Android: the credentials live in expo-secure-store, in
 * the same entry the React Native build uses. An item that is there but
 * can't be read or parsed, after the store's retries, is
 * [Stored.Unreadable], never signed out, and is never deleted
 * here, even where expo would (no Keystore key, a key that doesn't open
 * it): it may be the only copy of the person's account.
 */
class SecureStoreCredentialStore(private val secureStore: ExpoSecureStore) : CredentialStore {
    override fun read(): AuthCredentials? = load().presentOrNull()

    override fun load(): Stored<AuthCredentials> = secureStore.load(KEY, { it }) { HappyJson.decodeFromString(AuthCredentials.serializer(), it) }

    /** Whether the credential item is there, readable or not. */
    fun isStored(): Boolean = secureStore.contains(KEY)

    override fun write(credentials: AuthCredentials) {
        secureStore.setItem(KEY, HappyJson.encodeToString(AuthCredentials.serializer(), credentials))
    }

    override fun clear() = secureStore.deleteItem(KEY)

    companion object {
        /** tokenStorage.ts AUTH_KEY */
        const val KEY = "auth_credentials"
    }
}

/**
 * The item under [key], made by [decode]: left in place when it can't be
 * read ([ExpoSecureStore.getItem]'s `keep`), and [Stored.Unreadable] when it
 * can't, or isn't an account with a 32-byte secret ([credentials] of it).
 */
fun <T> ExpoSecureStore.load(key: String, credentials: (T) -> AuthCredentials, decode: (String) -> T): Stored<T> {
    var why: UnreadableItem? = null
    val stored = try {
        getItem(key, keep = true) { why = it }
    } catch (e: Exception) {
        Log.w(TAG, "Could not read credentials", e)
        return Stored.Unreadable(why?.let(UnreadableCredentials::Item) ?: UnreadableCredentials.Failed(e))
    }
    why?.let { return Stored.Unreadable(UnreadableCredentials.Item(it)) }
    stored ?: return Stored.Absent
    return try {
        val value = decode(stored)
        require(credentials(value).secretBytes().size == 32) { "The secret isn't 32 bytes" }
        Stored.Present(value)
    } catch (e: IllegalArgumentException) {
        Log.w(TAG, "Could not parse credentials", e)
        Stored.Unreadable(UnreadableCredentials.Invalid)
    }
}

private const val TAG = "CredentialStore"
