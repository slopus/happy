package com.slopus.happy.auth

import com.slopus.happy.crypto.AccountEncryption
import com.slopus.happy.crypto.AuthChallenge
import com.slopus.happy.crypto.Base64Variant
import com.slopus.happy.crypto.RandomSource
import com.slopus.happy.crypto.SecretKeyBackup
import com.slopus.happy.crypto.SecureRandomSource
import com.slopus.happy.crypto.decodeBase64
import com.slopus.happy.crypto.encodeBase64
import com.slopus.happy.net.HappyJson
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject

sealed interface AuthState {
    data object SignedOut : AuthState

    data class SignedIn(val credentials: AuthCredentials, val encryption: AccountEncryption) : AuthState {
        /** The account id, from the token (parseToken.ts); happy-app's `sync.serverID`. */
        val publicId: String? get() = tokenSubject(credentials.token)

        /** The secret in the backup format shown in Settings > Account. */
        val formattedSecretKey: String get() = SecretKeyBackup.format(credentials.secret)
    }
}

/** The secret key the user typed is not one. */
class InvalidSecretKeyException(cause: Throwable? = null) : IllegalArgumentException("Invalid secret key", cause)

/**
 * Account sign-in, as in happy-app: the account *is* a random 32-byte secret.
 * Creating an account and restoring one are the same exchange
 * (POST /v1/auth with a signed challenge); the server creates the account
 * the first time it sees the public key.
 */
class AuthRepository(
    private val credentialStore: CredentialStore,
    private val api: AuthApi,
    private val random: RandomSource = SecureRandomSource,
    private val io: CoroutineDispatcher = Dispatchers.IO,
) {
    private val mutableState = MutableStateFlow(signedIn(credentialStore.read()))
    val state: StateFlow<AuthState> = mutableState.asStateFlow()

    /** index.tsx createAccount */
    suspend fun createAccount() = login(random.nextBytes(32))

    /** restore/manual.tsx: accepts the dashed backup format or the raw base64url secret. */
    suspend fun restore(secretKey: String) {
        val secret = try {
            decodeBase64(SecretKeyBackup.normalize(secretKey), Base64Variant.Url)
        } catch (e: IllegalArgumentException) {
            throw InvalidSecretKeyException(e)
        }
        if (secret.size != 32) throw InvalidSecretKeyException()
        login(secret)
    }

    /**
     * restore/index.tsx after the other phone approved the link
     * ([AccountLinkRequest]): the server already issued the token, so it is
     * stored as is, as `auth.login(token, secret)` does.
     */
    suspend fun signIn(token: String, secret: ByteArray) {
        require(secret.size == 32) { "Invalid secret" }
        val credentials = AuthCredentials(token = token, secret = encodeBase64(secret, Base64Variant.Url))
        withContext(io) { credentialStore.write(credentials) }
        mutableState.value = signedIn(credentials)
    }

    private suspend fun login(secret: ByteArray) {
        signIn(api.getToken(AuthChallenge.create(secret, random)), secret)
    }

    /** Forgets the credentials. Clearing local data is the caller's job (AppGraph.logout). */
    suspend fun logout() {
        withContext(io) { credentialStore.clear() }
        mutableState.value = AuthState.SignedOut
    }

    private fun signedIn(credentials: AuthCredentials?): AuthState {
        if (credentials == null) return AuthState.SignedOut
        val secret = try {
            credentials.secretBytes()
        } catch (_: IllegalArgumentException) {
            return AuthState.SignedOut
        }
        if (secret.size != 32) return AuthState.SignedOut
        return AuthState.SignedIn(credentials, AccountEncryption.create(secret, random))
    }
}

/** parseToken.ts: the `sub` claim of the server's JWT, or null if it has none. */
fun tokenSubject(token: String): String? {
    val parts = token.split('.')
    if (parts.size != 3 || parts.any { it.isEmpty() }) return null
    return try {
        val payload = HappyJson.parseToJsonElement(decodeBase64(parts[1], Base64Variant.Url).decodeToString())
        (payload.jsonObject["sub"] as? JsonPrimitive)?.takeIf { it.isString }?.content
    } catch (_: IllegalArgumentException) {
        // Also covers SerializationException.
        null
    }
}
