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
import com.slopus.happy.connection.AgentConnectionCredentials
import com.slopus.happy.connection.AgentConnections
import com.slopus.happy.ui.connection.removeAgentConnection
import com.slopus.happy.ui.home.NewSessionDraftStore
import kotlinx.serialization.json.Json
import com.slopus.happy.crypto.Base64Variant
import com.slopus.happy.crypto.decodeHex
import com.slopus.happy.crypto.encodeBase64
import com.slopus.happy.sync.eventually
import com.slopus.happy.testing.SoftwareKeys
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
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
        for (name in listOf(ExpoSecureStore.PREFS_NAME, AccountStore.PREFS_NAME, AccountStore.CREDENTIALS_PREFS_NAME, ServerConfig.PREFS_NAME, AccountRemovals.PREFS_NAME, AgentConnections.REGISTRY_PREFS, AgentConnections.SECRETS_PREFS)) {
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

    private fun locked(graph: AppGraph) = graph.accountStore.locked()

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
            assertTrue(SecureStoreCredentialStore(ExpoSecureStore(prefs, read)).load(retry = true) is Stored.Unreadable)
            assertEquals("three tries", 1 + ExpoSecureStore.RETRY_MILLIS.size, read.asks)

            // The first start after the upgrade: no entry yet, and the unlock screen, not the first one.
            val failing = FailingKeys(keys, failure)
            val graph = graph(failing)
            assertEquals("three tries for the whole start", 1 + ExpoSecureStore.RETRY_MILLIS.size, failing.asks)
            assertEquals(failure.toString(), told, graph.rnImportFailure)
            assertLocked(graph, item)
            assertEquals(null, locked(graph)!!.id)
            assertEquals(UnreadableCredentials.Failed::class, locked(graph)!!.reason::class)
            assertFalse("a later read may open it", locked(graph)!!.reason.permanent)
            // Other reads (a switch, a sign-out) ask for it once more, with no wait: it may read now.
            graph.accountStore.reconcile()
            assertEquals(2 + ExpoSecureStore.RETRY_MILLIS.size, failing.asks)
        }
        // The Keystore back: the same item opens.
        assertTrue(graph().auth.state.value is AuthState.SignedIn)
    }

    @Test
    fun anImportedAccountKeepsItsEntryThroughAFailingStart() {
        rnSignedIn()
        rnServerSet()
        val first = graph()
        // Its profile sync may name it anew at any time: the name isn't what is compared.
        fun AccountRegistry.unnamed() = copy(entries = entries.map { it.copy(display = null) })
        val before = first.accountStore.registry.value.unnamed()

        // Launch N: the Keystore fails every try.
        val failing = graph(FailingKeys(keys, IllegalStateException("keystore2")))
        assertEquals(before, failing.accountStore.registry.value.unnamed())
        assertLocked(failing, rnItem)
        assertEquals(RnImportError.Keystore, failing.rnImportFailure?.reason)

        // Launch N+1: signed in, as before.
        val next = graph()
        assertEquals(before, next.accountStore.registry.value.unnamed())
        assertEquals(credentials, (next.auth.state.value as AuthState.SignedIn).credentials)
        assertNull(locked(next))
    }

    @Test
    fun retryOpensTheAccountOnceItReads() {
        rnSignedIn()
        // Every try of the start fails; the next succeeds.
        val graph = graph(FailingKeys(keys, ProviderException("keystore2"), failures = 1 + ExpoSecureStore.RETRY_MILLIS.size))
        assertLocked(graph, rnItem)
        val retry = graph.retryUnlock()
        assertTrue("retrying", graph.unlocking.value)
        runBlocking { retry.join() }
        assertFalse(graph.unlocking.value)
        assertEquals(credentials, (graph.auth.state.value as AuthState.SignedIn).credentials)
        assertEquals(OpenAccount.Happy(shared(graph)!!.id), graph.openAccount.value)
        assertEquals(CredentialLocation.Shared, shared(graph)?.location)
        eventually(message = "unlocked") { graph.locked.value == null }
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

        // Removing the account that can't be read: the item it was read from goes, and it doesn't come back.
        graph.accountStore.remove(id)
        assertNull(rnItem)
        assertNull(graph().accountStore.registry.value.entry(id))
    }

    @Test
    fun anAccountRemovedWhileUnreadableStaysRemovedWhenItsItemCantBeMatched() {
        rnSignedIn()
        val id = shared(graph())!!.id
        // An entry from before the item's fingerprint was kept.
        val registryPrefs = context.getSharedPreferences(AccountStore.PREFS_NAME, Context.MODE_PRIVATE)
        registryPrefs.edit().putString("registry", registryPrefs.getString("registry", null)!!.replace(Regex(""","sharedItem":"[0-9a-f]+""""), "")).commit()
        val item = rnItem

        val failing = graph(FailingKeys(keys, ProviderException("keystore2")))
        assertNull(shared(failing)!!.sharedItem)
        failing.accountStore.remove(id)
        assertEquals("not known to be its item: left", item, rnItem)

        val next = graph()
        assertNull("never brought back", next.accountStore.registry.value.entry(id))
        assertNull(locked(next))
        assertNull(next.rnImportFailure)
        assertEquals(AuthState.SignedOut, next.auth.state.value)
        // A new sign-in takes the place the person gave up.
        val other = AuthCredentials("other-token", encodeBase64(ByteArray(32) { 9 }, Base64Variant.Url))
        val otherId = next.accountStore.signIn(other, "https://other.test")
        assertEquals(CredentialLocation.Shared, next.accountStore.registry.value.entry(otherId)?.location)
        assertEquals(other, graph().accountStore.credentials(otherId)?.credentials)
    }

    @Test
    fun aLockedAccountMakesWayForOneThatReads() {
        rnSignedIn()
        val first = graph()
        val id = shared(first)!!.id
        val other = AuthCredentials("other-token", encodeBase64(ByteArray(32) { 9 }, Base64Variant.Url))
        val otherId = first.accountStore.signIn(other, "https://other.test")
        first.accountStore.select(id)

        val graph = graph(FailingKeys(keys, ProviderException("keystore2")))
        // The one that reads opens in its place from the first frame, and the person is told it couldn't be.
        assertEquals(other, (graph.auth.state.value as AuthState.SignedIn).credentials)
        assertEquals(otherId, graph.accountStore.registry.value.activeId)
        assertNull(locked(graph))
        assertEquals(RnImportError.Keystore, graph.rnImportFailure?.reason)
        // Still here, as one that can't be unlocked: picked, its page opens, not it.
        assertNotNull(graph.accountStore.registry.value.entry(id))
        assertNotNull(graph.accountStore.unreadable.value.reason(graph.accountStore.registry.value, id))
        assertTrue(graph.requestUnlock(id))
        runBlocking { graph.open(id).join() }
        assertEquals(otherId, graph.accountStore.registry.value.activeId)
        assertEquals(other, (graph.auth.state.value as AuthState.SignedIn).credentials)
        // Nothing told while another is open.
        assertNull(graph(FailingKeys(keys, ProviderException("keystore2"))).rnImportFailure)
    }

    @Test
    fun anItemNoReadWillOpenLocksOnlyUntilThePersonGoesOn() {
        rnSignedIn()
        val item = rnItem
        keys.secretKeys.clear()
        val graph = graph()
        assertTrue("only the secret key brings it back", locked(graph)!!.reason.permanent)

        // Use another account, then sign out of everything.
        val other = AuthCredentials("other-token", encodeBase64(ByteArray(32) { 9 }, Base64Variant.Url))
        val otherId = graph.accountStore.signIn(other, "https://other.test")
        assertNull(locked(graph))
        graph.accountStore.remove(otherId)
        assertEquals(emptyList<AccountEntry>(), graph.accountStore.registry.value.entries)
        assertNull(graph.accountStore.registry.value.activeId)
        assertNull("not the unlock screen again", locked(graph))
        val next = graph()
        assertNull(locked(next))
        assertNull("nothing to tell", next.rnImportFailure)
        assertEquals("never cleared on its own", item, rnItem)
    }

    @Test
    fun removeFromThisPhoneDeletesAnItemNoReadWillOpen() {
        rnSignedIn()
        keys.secretKeys.clear()
        val graph = graph()
        assertEquals(null, locked(graph)?.id)
        runBlocking { graph.removeUnreadable(null).join() }
        assertNull(rnItem)
        assertNull(locked(graph))
        assertNull(graph().rnImportFailure)
    }

    @Test
    fun anImportedAccountThatNoReadWillOpenIsRemovedWithItsItem() {
        rnSignedIn()
        val id = shared(graph())!!.id
        keys.secretKeys.clear()
        val graph = graph()
        assertEquals(id, locked(graph)?.id)
        assertTrue(locked(graph)!!.reason.permanent)
        runBlocking { graph.removeUnreadable(id).join(); graph.awaitRemovals() }
        assertNull(rnItem)
        assertNull(graph.accountStore.registry.value.entry(id))
        assertNull(locked(graph))
    }

    @Test
    fun theSameAccountSignedInAgainWhileUnreadableKeepsItsPlace() {
        rnSignedIn()
        rnServerSet()
        val first = graph()
        val id = shared(first)!!.id
        val other = AuthCredentials("other-token", encodeBase64(ByteArray(32) { 9 }, Base64Variant.Url))
        val otherId = first.accountStore.signIn(other, "https://other.test")
        first.close()

        // The other one open: only its profile sync names an entry.
        val failing = graph(FailingKeys(keys, ProviderException("keystore2")))
        failing.accountStore.updateDisplay(id, AccountDisplay(name = "Ada"))
        val before = failing.accountStore.registry.value.entry(id)!!
        assertEquals(CredentialLocation.Shared, before.location)
        assertEquals(id, failing.accountStore.signIn(credentials, "https://elsewhere.test"))
        assertEquals(before.copy(location = CredentialLocation.Own, sharedItem = null), failing.accountStore.registry.value.entry(id))
        // Its profile sync would name the open one: the other is open, so nothing does.
        failing.accountStore.select(otherId)

        // The Keystore back: the shared item wins, in the same place.
        val next = graph()
        val entry = next.accountStore.registry.value.entry(id)!!
        assertEquals(before.copy(sharedItem = entry.sharedItem), entry)
        assertEquals(listOf(id, otherId), next.accountStore.registry.value.ordered.map { it.id })
        assertNull("the own copy goes", next.accountStore.unreadable.value.own[id])
        assertFalse(ExpoSecureStore(context.getSharedPreferences(AccountStore.CREDENTIALS_PREFS_NAME, Context.MODE_PRIVATE), keys, keychainService = AccountStore.KEYCHAIN_SERVICE).contains(id))
    }

    @Test
    fun aHealthyKeystoreIsAskedAsBefore() {
        rnSignedIn()
        val asks = HashMap<String, Int>()
        val counting = object : SecureStoreKeys by keys {
            override fun secretKey(alias: String): SecretKey? {
                asks[alias] = (asks[alias] ?: 0) + 1
                return keys.secretKey(alias)
            }
        }
        // What the graph asked for at c8b9ee5e6 (before this change), step by step.
        val graph = graph(counting)
        // The start's reconcile, then the sign-in state's read.
        assertEquals(mapOf(RN_ALIAS to 2), asks.toMap())
        val id = shared(graph)!!.id
        asks.clear()
        graph.accountStore.credentials(id)
        assertEquals(mapOf(RN_ALIAS to 1), asks.toMap())
        asks.clear()
        val otherId = graph.accountStore.signIn(AuthCredentials("o", encodeBase64(ByteArray(32) { 9 }, Base64Variant.Url)), "https://other.test")
        assertEquals(mapOf(RN_ALIAS to 2, OWN_ALIAS to 1), asks.toMap())
        asks.clear()
        graph.accountStore.remove(otherId)
        assertEquals(emptyMap<String, Int>(), asks.toMap())
        asks.clear()
        graph.accountStore.remove(id)
        assertEquals(mapOf(RN_ALIAS to 1), asks.toMap())
    }

    @Test
    fun anAccountOfItsOwnKeepsItsEntryThroughAFailingRead() {
        rnSignedIn()
        val first = graph()
        val other = AuthCredentials("other-token", encodeBase64(ByteArray(32) { 9 }, Base64Variant.Url))
        val otherId = first.accountStore.signIn(other, "https://other.test")
        val before = first.accountStore.registry.value
        assertEquals(CredentialLocation.Own, before.entry(otherId)?.location)

        val failing = graph(FailingKeys(keys, ProviderException("keystore2"), alias = OWN_ALIAS))
        fun AccountRegistry.unnamed() = entries.map { it.copy(display = null) }
        assertEquals(before.unnamed(), failing.accountStore.registry.value.unnamed())
        assertEquals(setOf(otherId), failing.accountStore.unreadable.value.own.keys)
        // The one that reads opens in its place; this one waits in the account menu.
        assertEquals(credentials, (failing.auth.state.value as AuthState.SignedIn).credentials)
        assertNull(locked(failing))
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
        assertEquals(Stored.Unreadable(UnreadableCredentials.Item(UnreadableItem.Malformed)), SecureStoreCredentialStore(ExpoSecureStore(counting, keys)).load(retry = true))
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

    /** An agent connection paired before, as AgentConnections keeps it; [revoked] when the agent removed this phone. */
    private fun agentPaired(id: String = AGENT, revoked: Boolean = false) {
        ExpoSecureStore(context.getSharedPreferences(AgentConnections.SECRETS_PREFS, Context.MODE_PRIVATE), keys, keychainService = AgentConnections.KEYCHAIN_SERVICE)
            .setItem(id, Json.encodeToString(AgentConnectionCredentials.serializer(), AgentConnectionCredentials("127.0.0.1", 9, "dv1", "token")))
        context.getSharedPreferences(AgentConnections.REGISTRY_PREFS, Context.MODE_PRIVATE).edit()
            .putString("accounts", """[{"id":"$id","name":"Studio","addedAt":1,"revoked":$revoked}]""").commit()
    }

    /** The React Native account and one signed in after it; returns their ids, the second open. */
    private fun twoAccounts(): Pair<String, String> {
        rnSignedIn()
        val first = graph()
        val id = shared(first)!!.id
        val otherId = first.accountStore.signIn(AuthCredentials("other-token", encodeBase64(ByteArray(32) { 9 }, Base64Variant.Url)), "https://other.test")
        first.close()
        return id to otherId
    }

    @Test
    fun withOnlyAnAccountThatCantBeReadAnAgentConnectionOpensInstead() {
        rnSignedIn()
        val id = shared(graph())!!.id
        agentPaired()
        val graph = graph(FailingKeys(keys, ProviderException("keystore2")))
        eventually(message = "the agent connection open") { graph.openAccount.value == OpenAccount.Agent(AGENT) }
        assertNotNull(graph.accountStore.registry.value.entry(id))
    }

    @Test
    fun aRevokedAgentConnectionDoesntOpenInPlaceOfALockedAccount() {
        rnSignedIn()
        shared(graph())!!.id
        agentPaired(revoked = true)
        val graph = graph(FailingKeys(keys, ProviderException("keystore2")))
        assertNull(graph.usableAccount())
        Thread.sleep(200)
        assertEquals(OpenAccount.None, graph.openAccount.value)
        assertNotNull(locked(graph))
    }

    @Test
    fun removingTheOpenAgentConnectionOpensAnAccountThatReads() {
        val (id, otherId) = twoAccounts()
        agentPaired()
        context.getSharedPreferences(AccountStore.PREFS_NAME, Context.MODE_PRIVATE).let { prefs ->
            prefs.edit().putString("registry", prefs.getString("registry", null)!!.replace(""""activeId":"$otherId"""", """"activeId":"$AGENT"""")).commit()
        }
        val graph = graph(FailingKeys(keys, ProviderException("keystore2")))
        eventually(message = "the agent connection open") { graph.openAccount.value == OpenAccount.Agent(AGENT) }

        // The first account by order can't be read: the one that can opens.
        runBlocking { removeAgentConnection(graph, AGENT) }
        eventually(message = "the readable account open") { graph.openAccount.value == OpenAccount.Happy(otherId) }
        assertEquals(otherId, graph.accountStore.registry.value.activeId)
        assertNotNull(graph.accountStore.registry.value.entry(id))
    }

    @Test
    fun removingTheOpenAgentConnectionWithNothingUsableShowsTheUnlockState() {
        rnSignedIn()
        agentPaired()
        graph().apply { accountStore.select(AGENT); close() }
        val graph = graph(FailingKeys(keys, ProviderException("keystore2")))
        eventually(message = "the agent connection open") { graph.openAccount.value == OpenAccount.Agent(AGENT) }
        val id = graph.accountStore.registry.value.ordered.single().id

        // The only Happy account can't be read: it is selected, locked, and the removed connection isn't left selected.
        runBlocking { removeAgentConnection(graph, AGENT) }
        assertEquals(id, graph.accountStore.registry.value.activeId)
        assertEquals(OpenAccount.None, graph.openAccount.value)
        assertEquals(id, graph.accountStore.locked()?.id)
        assertNotEquals(AGENT, graph(FailingKeys(keys, ProviderException("keystore2"))).accountStore.registry.value.activeId)
    }

    @Test
    fun aKeystoreHiccupWhileAnAccountIsOpenLeavesItOpen() {
        rnSignedIn()
        val keystore = object : SecureStoreKeys by keys {
            @Volatile var failing = false
            override fun secretKey(alias: String): SecretKey? = if (failing && alias == RN_ALIAS) throw ProviderException("keystore2") else keys.secretKey(alias)
        }
        val graph = graph(keystore)
        val id = shared(graph)!!.id
        val otherId = graph.accountStore.signIn(AuthCredentials("other-token", encodeBase64(ByteArray(32) { 9 }, Base64Variant.Url)), "https://other.test")
        runBlocking { graph.open(id).join() }
        assertEquals(OpenAccount.Happy(id), graph.openAccount.value)

        // A read in passing (a removal's, a switch's) fails once.
        keystore.failing = true
        graph.accountStore.credentials(otherId)
        assertNotNull(graph.accountStore.unreadable.value.shared)
        Thread.sleep(300)
        assertEquals("still open", OpenAccount.Happy(id), graph.openAccount.value)
        assertEquals(credentials, (graph.auth.state.value as AuthState.SignedIn).credentials)

        // The next read in passing finds it again: no Retry needed.
        keystore.failing = false
        graph.accountStore.credentials(otherId)
        assertNull(graph.accountStore.unreadable.value.shared)
        assertEquals(id, graph.accountStore.registry.value.activeId)
    }

    @Test
    fun removingTheLastAccountFromItsUnlockPageWipesThePhoneAsAnySignOut() {
        rnSignedIn()
        val id = shared(graph())!!.id
        keys.secretKeys.clear()
        val drafts = context.getSharedPreferences(NewSessionDraftStore.PREFS_NAME, Context.MODE_PRIVATE)
        drafts.edit().putString("draft", "hello").commit()
        val graph = graph()
        assertEquals(id, locked(graph)?.id)
        runBlocking { graph.removeUnreadable(id).join(); graph.awaitRemovals() }
        assertNull(graph.accountStore.registry.value.entry(id))
        assertNull(rnItem)
        assertTrue("wiped", drafts.all.isEmpty())
    }

    companion object {
        private const val AGENT = "agent-connection-1"
        private const val DEFAULT = "https://api.cluster-fluster.com"
        private const val RN_SERVER = "https://api.cluster-fluster.com/"
        private const val RN_ALIAS = "AES/GCM/NoPadding:key_v1:keystoreUnauthenticated"
        private const val OWN_ALIAS = "AES/GCM/NoPadding:account:keystoreUnauthenticated"

        /** The data file's used part: the size, MMKV's random item-size holder, then `custom-server-url` = [RN_SERVER]. */
        private const val RN_SERVER_CONFIG =
            "38000000a0bf854a11637573746f6d2d7365727665722d75726c212068747470733a2f2f6170692e636c75737465722d666c75737465722e636f6d2f"

        /** MMKVMetaInfo (version 4): crc, version, sequence, IV, actual size, last confirmed size and crc, flags. */
        private const val RN_SERVER_CONFIG_CRC =
            "4af7d8780400000001000000000000000000000000000000000000003800000004000000b4bbd072000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
    }
}
