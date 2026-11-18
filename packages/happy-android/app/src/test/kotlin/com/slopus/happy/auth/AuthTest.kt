package com.slopus.happy.auth

import android.content.Context
import android.content.SharedPreferences
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.analytics.AnalyticsReasons
import com.slopus.happy.analytics.SignInError
import com.slopus.happy.crypto.Base64Variant
import com.slopus.happy.crypto.SecretKeyBackup
import com.slopus.happy.crypto.encodeBase64
import com.slopus.happy.net.HappyHttp
import com.slopus.happy.testing.FakeHappyServer
import com.slopus.happy.testing.SoftwareKeys
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.runTest
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class AuthTest {
    private lateinit var server: FakeHappyServer
    private lateinit var prefs: SharedPreferences
    private val keys = SoftwareKeys()

    @Before
    fun setUp() {
        server = FakeHappyServer().start()
        prefs = ApplicationProvider.getApplicationContext<Context>()
            .getSharedPreferences(ExpoSecureStore.PREFS_NAME, Context.MODE_PRIVATE)
            .also { it.edit().clear().commit() }
    }

    @After
    fun tearDown() = server.close()

    private fun http() = HappyHttp(OkHttpClient(), serverUrl = { server.url }, clientId = "android/test")

    private fun repository() =
        AuthRepository(SecureStoreCredentialStore(ExpoSecureStore(prefs, keys)), AuthApi(http()), io = Dispatchers.Unconfined)

    @Test
    fun createAccountSignsInWithAFreshSecret() = runTest {
        val auth = repository()
        assertEquals(AuthState.SignedOut, auth.state.value)

        auth.createAccount()

        val signedIn = auth.state.value as AuthState.SignedIn
        assertEquals(server.token, signedIn.credentials.token)
        assertEquals(32, signedIn.credentials.secretBytes().size)
        assertEquals("account-1", signedIn.publicId)
        assertEquals(1, server.authenticatedKeys.size)
        val request = server.requestsTo("/v1/auth").single()
        assertEquals("android/test", request.headers["X-Happy-Client"])
        // Credentials survive a restart.
        assertEquals(signedIn.credentials, repository().let { (it.state.value as AuthState.SignedIn).credentials })
    }

    @Test
    fun restoreAcceptsTheBackupFormatAndTheRawSecret() = runTest {
        val raw = encodeBase64(server.secret, Base64Variant.Url)
        for (input in listOf(SecretKeyBackup.format(raw), raw, " ${SecretKeyBackup.format(raw).lowercase()} ")) {
            val auth = repository()
            auth.restore(input)
            val signedIn = auth.state.value as AuthState.SignedIn
            assertArrayEquals(server.secret, signedIn.credentials.secretBytes())
            assertEquals(server.encryption.anonId, signedIn.encryption.anonId)
            assertEquals(SecretKeyBackup.format(raw), signedIn.formattedSecretKey)
            auth.logout()
        }
        assertEquals(List(3) { server.publicKey }, server.authenticatedKeys.toList())
    }

    @Test
    fun restoreRejectsWhatIsNotAKey() = runTest {
        val auth = repository()
        for (input in listOf("not a key", "AAAAA-BBBBB", encodeBase64(ByteArray(16), Base64Variant.Url))) {
            val error = runCatching { auth.restore(input) }.exceptionOrNull()
            assertTrue("$input: $error", error is InvalidSecretKeyException)
        }
        assertEquals(AuthState.SignedOut, auth.state.value)
        assertTrue(server.authenticatedKeys.isEmpty())
    }

    /** Each step of a restore that fails is its own `sign_in_failed` code; nothing is signed in. */
    @Test
    fun aFailedRestoreSaysWhichStepFailed() = runTest {
        val backup = SecretKeyBackup.format(encodeBase64(server.secret, Base64Variant.Url))
        suspend fun failure(auth: AuthRepository, key: String = backup): SignInError {
            val error = runCatching { auth.restore(key) }.exceptionOrNull() ?: error("signed in")
            assertEquals(AuthState.SignedOut, auth.state.value)
            return AnalyticsReasons.relaySignIn(error)
        }
        fun answering(response: MockResponse) = MockWebServer().apply {
            dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest) = response
            }
            start()
        }
        fun at(edge: MockWebServer) =
            AuthRepository(SecureStoreCredentialStore(ExpoSecureStore(prefs, keys)), AuthApi(HappyHttp(OkHttpClient(), { edge.url("/").toString().trimEnd('/') }, "android/test")), io = Dispatchers.Unconfined)

        assertEquals(SignInError.InvalidToken, failure(repository(), "hello robot"))
        for ((response, code) in listOf(
            MockResponse.Builder().code(401).body("""{"error":"Invalid signature"}""").build() to SignInError.Rejected,
            MockResponse.Builder().code(429).build() to SignInError.RateLimited,
            MockResponse.Builder().code(500).body("{}").build() to SignInError.ServerError,
            MockResponse.Builder().code(502).body("<html>Bad gateway</html>").build() to SignInError.ServerError,
            MockResponse.Builder().code(200).body("<html>Just a moment...</html>").build() to SignInError.InvalidResponse,
        )) {
            val edge = answering(response)
            assertEquals("${response.code}", code, failure(at(edge)))
            edge.close()
        }
        val gone = answering(MockResponse.Builder().build()).also { it.close() }
        assertEquals(SignInError.Unreachable, failure(at(gone)))

        // The server gave a token, but the phone couldn't keep it.
        val refusing = object : CredentialStore {
            override fun read(): AuthCredentials? = null
            override fun write(credentials: AuthCredentials) = throw java.security.KeyStoreException("Keystore unavailable")
            override fun clear() {}
        }
        assertEquals(SignInError.StorageFailed, failure(AuthRepository(refusing, AuthApi(http()), io = Dispatchers.Unconfined)))
    }

    @Test
    fun logoutForgetsTheCredentials() = runTest {
        val auth = repository()
        auth.createAccount()
        auth.logout()
        assertEquals(AuthState.SignedOut, auth.state.value)
        assertEquals(AuthState.SignedOut, repository().state.value)
        assertTrue(prefs.all.isEmpty())
    }

    @Test
    fun anAccountSignedInByTheReactNativeBuildIsSignedInHere() = runTest {
        // What happy-app leaves after login: tokenStorage.ts's JSON in expo-secure-store.
        val secret = encodeBase64(server.secret, Base64Variant.Url)
        ExpoSecureStore(prefs, keys).setItem("auth_credentials", """{"token":"${server.token}","secret":"$secret"}""")

        val signedIn = repository().state.value as AuthState.SignedIn
        assertEquals(server.token, signedIn.credentials.token)
        assertEquals(server.encryption.anonId, signedIn.encryption.anonId)
    }

    @Test
    fun tokenSubjectReadsTheJwtSub() {
        assertEquals("account-1", tokenSubject(server.token))
        assertNull(tokenSubject("a.b"))
        assertNull(tokenSubject("a.!!!.c"))
        assertNull(tokenSubject("a.${encodeBase64("{}".toByteArray(), Base64Variant.Url)}.c"))
    }

    @Test
    fun serverProbe() = runTest {
        val api = AuthApi(http())
        assertEquals(AuthApi.ServerProbe.HappyServer, api.probeServer(server.url))
        assertEquals(AuthApi.ServerProbe.ServerError, api.probeServer(server.url + "/missing"))
        assertEquals(AuthApi.ServerProbe.Unreachable, api.probeServer("http://127.0.0.1:1"))
        assertEquals(AuthApi.ServerProbe.Unreachable, api.probeServer("not a url"))
    }
}
