package com.slopus.happy.accounts

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.AppGraph
import com.slopus.happy.OpenAccount
import com.slopus.happy.analytics.AnalyticsEvent
import com.slopus.happy.analytics.RnImportError
import com.slopus.happy.auth.AuthCredentials
import com.slopus.happy.auth.AuthState
import com.slopus.happy.auth.ExpoSecureStore
import com.slopus.happy.auth.SecureStoreCredentialStore
import com.slopus.happy.auth.SecureStoreKeys
import com.slopus.happy.auth.Stored
import com.slopus.happy.auth.UnreadableCredentials
import com.slopus.happy.auth.UnreadableItem
import com.slopus.happy.config.ServerConfig
import com.slopus.happy.crypto.Base64Variant
import com.slopus.happy.crypto.decodeHex
import com.slopus.happy.crypto.encodeBase64
import com.slopus.happy.sync.eventually
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
 * can't open them still builds the graph and says why, after asking a
 * failing Keystore again.
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

    /** The Keystore, failing its first [failures] asks for [alias] (every one when null) with [failure]; [asks] counts them. */
    private class FailingKeys(
        val keys: SecureStoreKeys,
        val failure: Exception,
        val failures: Int? = null,
        val alias: String = RN_ALIAS,
    ) : SecureStoreKeys by keys {
        var asks = 0
        override fun secretKey(alias: String): SecretKey? {
            if (alias != this.alias) return keys.secretKey(alias)
            asks++
            if (failures == null || asks <= failures) throw failure
            return keys.secretKey(alias)
        }
        override fun privateKey(alias: String): PrivateKey? = throw failure
    }

    private val rnItem get() = prefs.getString("key_v1-auth_credentials", null)

    private fun locked(graph: AppGraph) = graph.locked.value

    /** Not signed out: nothing open, the unlock screen's reason set, the item as it was. */
    private fun assertLocked(graph: AppGraph, item: String?) {
        assertEquals(OpenAccount.None, graph.openAccount.value)
        assertTrue("locked, not signed out", locked(graph) != null)
        assertEquals("never deleted or written over", item, rnItem)
    }

    @Test
    fun aReadThatThrowsOnceIsAskedAgainAndNothingIsTold() {
        rnSignedIn()
        val failing = FailingKeys(keys, ProviderException("keystore2"), failures = 1)
        val graph = graph(failing)
        assertEquals(credentials, (graph.auth.state.value as AuthState.SignedIn).credentials)
        assertNull(graph.rnImportFailure)
        assertNull(locked(graph))
        assertEquals(CredentialLocation.Shared, shared(graph)?.location)
    }

    @Test
    fun aReadThatAlwaysThrowsIsTriedThreeTimesAndTold() {
        rnSignedIn()
        val failures = listOf(
            ProviderException("keystore2") to AnalyticsEvent.RnImportFailed(RnImportError.Keystore, "java.security.ProviderException"),
            IllegalStateException("keystore2", ProviderException("binder")) to
                AnalyticsEvent.RnImportFailed(RnImportError.Keystore, "java.lang.IllegalStateException", "java.security.ProviderException"),
            IOException("load") to AnalyticsEvent.RnImportFailed(RnImportError.Keystore, "java.io.IOException"),
        )
        val item = rnItem
        for ((failure, told) in failures) {
            val read = FailingKeys(keys, failure)
            assertTrue(SecureStoreCredentialStore(ExpoSecureStore(prefs, read)).load() is Stored.Unreadable)
            assertEquals("three tries", 1 + ExpoSecureStore.RETRY_MILLIS.size, read.asks)

            // The first start after the upgrade: no entry yet, and the unlock screen, not the first one.
            val graph = graph(FailingKeys(keys, failure))
            assertEquals(failure.toString(), told, graph.rnImportFailure)
            assertLocked(graph, item)
            assertEquals(UnreadableCredentials.Failed::class, locked(graph)!!::class)
        }
        // The Keystore back: the same item opens.
        assertTrue(graph().auth.state.value is AuthState.SignedIn)
    }

    @Test
    fun anImportedAccountKeepsItsEntryThroughAFailingStart() {
        rnSignedIn()
        rnServerSet()
        val first = graph()
        val entry = shared(first)!!
        // Its profile sync names the entry too: stopped, so only this one does.
        first.close()
        first.accountStore.updateDisplay(entry.id, AccountDisplay(name = "Ada"))
        val before = first.accountStore.registry.value

        // Launch N: the Keystore fails every try.
        val failing = graph(FailingKeys(keys, IllegalStateException("keystore2")))
        assertEquals(before, failing.accountStore.registry.value)
        assertLocked(failing, rnItem)
        assertEquals(RnImportError.Keystore, failing.rnImportFailure?.reason)

        // Launch N+1: signed in, as before.
        val next = graph()
        assertEquals(before, next.accountStore.registry.value)
        assertEquals(credentials, (next.auth.state.value as AuthState.SignedIn).credentials)
        assertNull(locked(next))
    }

    @Test
    fun retryOpensTheAccountOnceItReads() {
        rnSignedIn()
        // Every try of the start fails; the next succeeds.
        val graph = graph(FailingKeys(keys, ProviderException("keystore2"), failures = 1 + ExpoSecureStore.RETRY_MILLIS.size))
        assertLocked(graph, rnItem)
        runBlocking { graph.retryUnlock().join() }
        assertEquals(credentials, (graph.auth.state.value as AuthState.SignedIn).credentials)
        assertEquals(CredentialLocation.Shared, shared(graph)?.location)
        eventually(message = "unlocked") { locked(graph) == null }
    }

    @Test
    fun aSignInWhileUnreadableLeavesTheItemAndTakesAnItemOfItsOwn() {
        rnSignedIn()
        rnServerSet()
        val id = shared(graph())!!.id
        val item = rnItem
        val graph = graph(FailingKeys(keys, ProviderException("keystore2")))
        val other = AuthCredentials("other-token", encodeBase64(ByteArray(32) { 9 }, Base64Variant.Url))
        val otherId = graph.accountStore.signIn(other, "https://other.test")
        assertEquals(item, rnItem)
        val registry = graph.accountStore.registry.value
        assertEquals(CredentialLocation.Own, registry.entry(otherId)?.location)
        assertEquals("the React Native account keeps its place", CredentialLocation.Shared, registry.entry(id)?.location)
        assertEquals(otherId, registry.activeId)

        // Removing the account that can't be read leaves its item.
        graph.accountStore.remove(id)
        assertEquals(item, rnItem)
        // Readable again, it comes back.
        assertTrue(graph().accountStore.registry.value.entries.any { it.id == id && it.location == CredentialLocation.Shared })
    }

    @Test
    fun anAccountOfItsOwnKeepsItsEntryThroughAFailingRead() {
        rnSignedIn()
        val first = graph()
        val other = AuthCredentials("other-token", encodeBase64(ByteArray(32) { 9 }, Base64Variant.Url))
        val otherId = first.accountStore.signIn(other, "https://other.test")
        val before = first.accountStore.registry.value
        assertEquals(CredentialLocation.Own, before.entry(otherId)?.location)

        val failing = graph(FailingKeys(keys, ProviderException("keystore2"), alias = "AES/GCM/NoPadding:account:keystoreUnauthenticated"))
        assertEquals(before, failing.accountStore.registry.value)
        assertEquals(setOf(otherId), failing.accountStore.unreadable.value.own.keys)
        assertTrue("the open one, locked", locked(failing) != null)
        assertNull("not the React Native account's", failing.rnImportFailure)

        assertEquals(other, graph().accountStore.credentials(otherId)?.credentials)
    }

    @Test
    fun anItemWithoutItsKeystoreKeyIsKeptAndLocked() {
        rnSignedIn()
        val item = rnItem
        keys.secretKeys.clear()
        val graph = graph()
        assertEquals(AnalyticsEvent.RnImportFailed(RnImportError.KeyMissing), graph.rnImportFailure)
        assertLocked(graph, item)
        // Every start, until it opens; only the secret key brings the account back here.
        assertEquals(AnalyticsEvent.RnImportFailed(RnImportError.KeyMissing), graph().rnImportFailure)
    }

    @Test
    fun anItemThatIsNotExposEnvelopeIsReadOnce() {
        prefs.edit().putString("key_v1-auth_credentials", """{"iv":"nBmdvULTbWbzEE27","tlen":128}""").commit()
        var reads = 0
        val counting = object : android.content.SharedPreferences by prefs {
            override fun getString(key: String?, defValue: String?): String? = prefs.getString(key, defValue).also { if (key == "key_v1-auth_credentials") reads++ }
        }
        assertEquals(Stored.Unreadable(UnreadableCredentials.Item(UnreadableItem.Malformed)), SecureStoreCredentialStore(ExpoSecureStore(counting, keys)).load())
        assertEquals(1, reads)

        val graph = graph()
        assertEquals(AnalyticsEvent.RnImportFailed(RnImportError.MalformedItem), graph.rnImportFailure)
        assertLocked(graph, """{"iv":"nBmdvULTbWbzEE27","tlen":128}""")
    }

    @Test
    fun credentialsThatAreNotAnAccountAreLocked() {
        rnSignedIn(AuthCredentials("rn-token", encodeBase64(ByteArray(16), Base64Variant.Url)))
        assertEquals(AnalyticsEvent.RnImportFailed(RnImportError.InvalidCredentials), graph().rnImportFailure)
        ExpoSecureStore(prefs, keys).setItem("auth_credentials", """{"token":"rn-token"}""")
        val graph = graph()
        assertEquals(AnalyticsEvent.RnImportFailed(RnImportError.InvalidCredentials), graph.rnImportFailure)
        assertLocked(graph, rnItem)
    }

    @Test
    fun aServerSettingThatCantBeTrustedIsSaidOnce() {
        rnSignedIn()
        rnServerSet()
        // A torn write: the checksum no longer matches.
        File(mmkv, "server-config").writeBytes(decodeHex(RN_SERVER_CONFIG.replace("636f6d2f", "636f6d3f")))
        val graph = graph()
        assertFalse(shared(graph)!!.serverConfirmed)
        assertEquals(AnalyticsEvent.RnImportFailed(RnImportError.ServerUnconfirmed), graph.rnImportFailure)
        assertNull("imported already", graph().rnImportFailure)
    }

    companion object {
        private const val DEFAULT = "https://api.cluster-fluster.com"
        private const val RN_SERVER = "https://api.cluster-fluster.com/"
        private const val RN_ALIAS = "AES/GCM/NoPadding:key_v1:keystoreUnauthenticated"

        /** The data file's used part: the size, MMKV's random item-size holder, then `custom-server-url` = [RN_SERVER]. */
        private const val RN_SERVER_CONFIG =
            "38000000a0bf854a11637573746f6d2d7365727665722d75726c212068747470733a2f2f6170692e636c75737465722d666c75737465722e636f6d2f"

        /** MMKVMetaInfo (version 4): crc, version, sequence, IV, actual size, last confirmed size and crc, flags. */
        private const val RN_SERVER_CONFIG_CRC =
            "4af7d8780400000001000000000000000000000000000000000000003800000004000000b4bbd072000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
    }
}
