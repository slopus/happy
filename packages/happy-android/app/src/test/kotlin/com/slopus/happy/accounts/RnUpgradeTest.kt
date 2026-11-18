package com.slopus.happy.accounts

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.AppGraph
import com.slopus.happy.analytics.RnImportError
import com.slopus.happy.auth.AuthCredentials
import com.slopus.happy.auth.AuthState
import com.slopus.happy.auth.ExpoSecureStore
import com.slopus.happy.auth.SecureStoreCredentialStore
import com.slopus.happy.auth.SecureStoreKeys
import com.slopus.happy.config.ServerConfig
import com.slopus.happy.crypto.Base64Variant
import com.slopus.happy.crypto.decodeHex
import com.slopus.happy.crypto.encodeBase64
import com.slopus.happy.testing.SoftwareKeys
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.IOException
import java.security.PrivateKey
import java.security.ProviderException
import javax.crypto.SecretKey

/**
 * Installing this app over the React Native build: what the first start
 * makes of the React Native app's credential item and server setting, in
 * the files that build leaves (happy-app 1.8.0, expo-secure-store 55.0.9,
 * react-native-mmkv 3.3.3, read off an emulator), and that a start which
 * can't open them still builds the graph and says why.
 */
@RunWith(AndroidJUnit4::class)
class RnUpgradeTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private val keys = SoftwareKeys()
    private val graphs = mutableListOf<AppGraph>()
    private val secret = ByteArray(32) { (it * 7 + 1).toByte() }
    private val credentials = AuthCredentials("rn-token", encodeBase64(secret, Base64Variant.Url))
    private val prefs get() = context.getSharedPreferences(ExpoSecureStore.PREFS_NAME, Context.MODE_PRIVATE)
    private val mmkv get() = File(context.filesDir, "mmkv")

    @Before
    fun setUp() {
        for (name in listOf(ExpoSecureStore.PREFS_NAME, AccountStore.PREFS_NAME, AccountStore.CREDENTIALS_PREFS_NAME, ServerConfig.PREFS_NAME, AccountRemovals.PREFS_NAME)) {
            context.getSharedPreferences(name, Context.MODE_PRIVATE).edit().clear().commit()
        }
        mmkv.deleteRecursively()
    }

    @After
    fun tearDown() {
        graphs.forEach { runBlocking { it.account.value?.stop(); it.awaitRemovals() } }
    }

    private fun graph(keys: SecureStoreKeys = this.keys) =
        AppGraph(context, "android/test", DEFAULT, keys, databaseName = null).also { graphs += it }

    /** What tokenStorage.ts leaves: `JSON.stringify({token, secret})` in `key_v1-auth_credentials`, under the RN build's Keystore key. */
    private fun rnSignedIn(value: AuthCredentials = credentials) =
        SecureStoreCredentialStore(ExpoSecureStore(prefs, keys)).write(value)

    /** `files/mmkv/server-config` and its `.crc` as the React Native build wrote them after Settings › Server saved [RN_SERVER]. */
    private fun rnServerSet() {
        mmkv.mkdirs()
        File(mmkv, "server-config").writeBytes(decodeHex(RN_SERVER_CONFIG) + ByteArray(4096 - RN_SERVER_CONFIG.length / 2))
        File(mmkv, "server-config.crc").writeBytes(decodeHex(RN_SERVER_CONFIG_CRC) + ByteArray(4096 - RN_SERVER_CONFIG_CRC.length / 2))
    }

    private fun shared(graph: AppGraph) = graph.accountStore.registry.value.entries.singleOrNull { it.location == CredentialLocation.Shared }

    @Test
    fun theReactNativeAccountOpensOnItsServer() {
        rnSignedIn()
        rnServerSet()
        val graph = graph()
        assertEquals(RN_SERVER.trimEnd('/'), shared(graph)?.serverUrl)
        assertTrue(shared(graph)!!.serverConfirmed)
        assertEquals(credentials, (graph.auth.state.value as AuthState.SignedIn).credentials)
        assertNull(graph.rnImportFailure)
    }

    @Test
    fun withoutAServerSettingItOpensOnTheDefault() {
        rnSignedIn()
        val graph = graph()
        assertEquals(DEFAULT, shared(graph)?.serverUrl)
        assertTrue(graph.auth.state.value is AuthState.SignedIn)
        assertNull(graph.rnImportFailure)
    }

    @Test
    fun aFreshInstallHasNothingToTell() {
        assertNull(graph().rnImportFailure)
    }

    @Test
    fun anItemWithoutItsKeystoreKeyIsDroppedAndSaid() {
        rnSignedIn()
        keys.secretKeys.clear()
        val graph = graph()
        assertEquals(AuthState.SignedOut, graph.auth.state.value)
        assertEquals(RnImportError.KeyMissing, graph.rnImportFailure)
        assertFalse("deleted, as expo does", prefs.contains("key_v1-auth_credentials"))
        // Said once: the next start has no item.
        assertNull(graph().rnImportFailure)
    }

    @Test
    fun aKeystoreThatFailsSignsOutInsteadOfStoppingTheStart() {
        rnSignedIn()
        for (failure in listOf(ProviderException("keystore2"), IllegalStateException("keystore2"), IOException("load"))) {
            val failing = object : SecureStoreKeys by keys {
                override fun secretKey(alias: String): SecretKey? = throw failure
                override fun privateKey(alias: String): PrivateKey? = throw failure
            }
            val graph = graph(failing)
            assertEquals(AuthState.SignedOut, graph.auth.state.value)
            assertEquals(failure.toString(), RnImportError.Keystore, graph.rnImportFailure)
            assertTrue("left for a start that can read it", prefs.contains("key_v1-auth_credentials"))
        }
        // The Keystore back: the same item opens.
        assertTrue(graph().auth.state.value is AuthState.SignedIn)
    }

    @Test
    fun anItemThatIsNotExposEnvelopeIsSaid() {
        prefs.edit().putString("key_v1-auth_credentials", """{"iv":"nBmdvULTbWbzEE27","tlen":128}""").commit()
        val graph = graph()
        assertEquals(AuthState.SignedOut, graph.auth.state.value)
        assertEquals(RnImportError.MalformedItem, graph.rnImportFailure)
    }

    @Test
    fun credentialsThatAreNotAnAccountAreSaid() {
        rnSignedIn(AuthCredentials("rn-token", encodeBase64(ByteArray(16), Base64Variant.Url)))
        assertEquals(RnImportError.InvalidCredentials, graph().rnImportFailure)
        ExpoSecureStore(prefs, keys).setItem("auth_credentials", """{"token":"rn-token"}""")
        assertEquals(RnImportError.InvalidCredentials, graph().rnImportFailure)
    }

    @Test
    fun aServerSettingThatCantBeTrustedIsSaidOnce() {
        rnSignedIn()
        rnServerSet()
        // A torn write: the checksum no longer matches.
        File(mmkv, "server-config").writeBytes(decodeHex(RN_SERVER_CONFIG.replace("636f6d2f", "636f6d3f")))
        val graph = graph()
        assertFalse(shared(graph)!!.serverConfirmed)
        assertEquals(RnImportError.ServerUnconfirmed, graph.rnImportFailure)
        assertNull("imported already", graph().rnImportFailure)
    }

    companion object {
        private const val DEFAULT = "https://api.cluster-fluster.com"
        private const val RN_SERVER = "https://api.cluster-fluster.com/"

        /** The data file's used part: the size, MMKV's random item-size holder, then `custom-server-url` = [RN_SERVER]. */
        private const val RN_SERVER_CONFIG =
            "38000000a0bf854a11637573746f6d2d7365727665722d75726c212068747470733a2f2f6170692e636c75737465722d666c75737465722e636f6d2f"

        /** MMKVMetaInfo (version 4): crc, version, sequence, IV, actual size, last confirmed size and crc, flags. */
        private const val RN_SERVER_CONFIG_CRC =
            "4af7d8780400000001000000000000000000000000000000000000003800000004000000b4bbd072000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
    }
}
