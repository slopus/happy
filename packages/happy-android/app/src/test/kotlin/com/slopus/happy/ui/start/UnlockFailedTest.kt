package com.slopus.happy.ui.start

import android.content.Context
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.AppGraph
import com.slopus.happy.accounts.AccountStore
import com.slopus.happy.auth.AuthCredentials
import com.slopus.happy.auth.AuthState
import com.slopus.happy.auth.ExpoSecureStore
import com.slopus.happy.auth.SecureStoreCredentialStore
import com.slopus.happy.auth.SecureStoreKeys
import com.slopus.happy.crypto.Base64Variant
import com.slopus.happy.crypto.encodeBase64
import com.slopus.happy.testing.SoftwareKeys
import com.slopus.happy.ui.HappyApp
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.home.AccountMenuTags
import com.slopus.happy.ui.onboarding.RestoreTags
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import javax.crypto.SecretKey

/** The first start after the upgrade with a React Native account the Keystore won't open: the unlock screen, not the first one. */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class UnlockFailedTest {
    @get:Rule
    val rule = createComposeRule()

    private val context = ApplicationProvider.getApplicationContext<Context>()
    private val keys = SoftwareKeys()
    private val prefs get() = context.getSharedPreferences(ExpoSecureStore.PREFS_NAME, Context.MODE_PRIVATE)
    private val rnItem get() = prefs.getString("key_v1-auth_credentials", null)
    private val credentials = AuthCredentials("rn-token", encodeBase64(ByteArray(32) { 3 }, Base64Variant.Url))
    private lateinit var graph: AppGraph

    /** [keys], throwing while [failing]. */
    private val keystore = object : SecureStoreKeys by keys {
        var failing = true
        override fun secretKey(alias: String): SecretKey? = if (failing && alias == RN_ALIAS) throw IllegalStateException("keystore2") else keys.secretKey(alias)
    }

    @Before
    fun setUp() {
        for (name in listOf(ExpoSecureStore.PREFS_NAME, AccountStore.PREFS_NAME, AccountStore.CREDENTIALS_PREFS_NAME)) {
            context.getSharedPreferences(name, Context.MODE_PRIVATE).edit().clear().commit()
        }
        SecureStoreCredentialStore(ExpoSecureStore(prefs, keys)).write(credentials)
    }

    private fun start(keys: SecureStoreKeys = keystore) {
        graph = AppGraph(context, "android/test", "https://api.cluster-fluster.com", keys, databaseName = null)
        rule.setContent { HappyApp(graph) }
    }

    @After
    fun tearDown() {
        runBlocking { graph.account.value?.stop(); graph.awaitRemovals() }
    }

    @Test
    fun retryOpensTheAccountOnceTheKeystoreAnswers() {
        start()
        rule.waitUntilAtLeastOneExists(hasTestTag(UnlockFailedTags.PAGE), 5_000)
        rule.onNodeWithText("Couldn't unlock your account").assertExists()
        rule.onNodeWithText("Start").assertDoesNotExist()

        keystore.failing = false
        rule.onNodeWithText("Retry").performClick()
        rule.waitUntil(5_000) { graph.auth.state.value is AuthState.SignedIn }
        assertEquals(credentials, (graph.auth.state.value as AuthState.SignedIn).credentials)
        rule.waitUntilDoesNotExist(hasTestTag(UnlockFailedTags.PAGE), 5_000)
    }

    @Test
    fun withNothingElseItOffersTheAccountMenuAndAdd() {
        start()
        val item = rnItem
        rule.waitUntilAtLeastOneExists(hasTestTag(UnlockFailedTags.PAGE), 5_000)
        rule.onNodeWithTag(AccountMenuTags.BUTTON).performClick()
        rule.onNodeWithTag(AccountMenuTags.ADD).assertExists()
    }

    @Test
    fun addAccountGoesWhereStartDoesAndLeavesTheItem() {
        start()
        val item = rnItem
        rule.waitUntilAtLeastOneExists(hasTestTag(UnlockFailedTags.PAGE), 5_000)
        rule.onNodeWithText("Add account").performClick()
        rule.waitUntilAtLeastOneExists(hasTestTag(InstallDesktopTags.CONTENT), 5_000)
        assertEquals(item, rnItem)
        assertTrue(graph.locked.value != null)
    }

    /** The React Native account, and another account signed in after it; [open] the one open. */
    private fun twoAccounts(open: Open): Pair<String, AuthCredentials> {
        val first = AppGraph(context, "android/test", "https://api.cluster-fluster.com", keys, databaseName = null)
        val id = first.accountStore.registry.value.entries.single().id
        val other = AuthCredentials("other-token", encodeBase64(ByteArray(32) { 9 }, Base64Variant.Url))
        first.accountStore.signIn(other, "https://other.test")
        if (open == Open.ReactNative) first.accountStore.select(id)
        runBlocking { first.account.value?.stop(); first.awaitRemovals() }
        first.close()
        return id to other
    }

    private enum class Open { ReactNative, Other }

    @Test
    fun theOneThatReadsOpensInsteadAndTheOtherShowsAsLocked() {
        val (id, other) = twoAccounts(Open.ReactNative)
        start()
        rule.waitUntilAtLeastOneExists(hasTestTag(AccountMenuTags.BUTTON), 5_000)
        assertEquals(other, (graph.auth.state.value as AuthState.SignedIn).credentials)
        rule.onNodeWithTag(UnlockFailedTags.PAGE).assertDoesNotExist()

        rule.onNodeWithTag(AccountMenuTags.BUTTON).performClick()
        rule.onNode(hasTestTag(AccountMenuTags.entry(id)) and hasText("Can't unlock")).assertExists()
    }

    @Test
    fun anAccountThatCantBeUnlockedOpensItsPageNotInPlaceOfTheOpenOne() {
        val (id, other) = twoAccounts(Open.Other)
        start()
        rule.waitUntilAtLeastOneExists(hasTestTag(AccountMenuTags.BUTTON), 5_000)
        rule.onNodeWithTag(AccountMenuTags.BUTTON).performClick()
        rule.onNodeWithTag(AccountMenuTags.entry(id)).performClick()

        rule.waitUntilAtLeastOneExists(hasTestTag(UnlockFailedTags.PAGE), 5_000)
        rule.onNodeWithText("Your phone's secure storage didn't respond. Your account is still saved on this phone.").assertExists()
        assertEquals("the open one stays", other, (graph.auth.state.value as AuthState.SignedIn).credentials)

        // The Keystore back: Retry opens it.
        keystore.failing = false
        rule.onNodeWithText("Retry").performClick()
        rule.waitUntil(5_000) { (graph.auth.state.value as? AuthState.SignedIn)?.credentials == credentials }
        rule.waitUntilDoesNotExist(hasTestTag(UnlockFailedTags.PAGE), 5_000)
    }

    @Test
    fun aPageOfAnAccountNoReadWillOpenOffersRestoreAndRemove() {
        val (id, other) = twoAccounts(Open.Other)
        keys.secretKeys.remove(RN_ALIAS)
        start(keys)
        rule.waitUntilAtLeastOneExists(hasTestTag(AccountMenuTags.BUTTON), 5_000)
        rule.onNodeWithTag(AccountMenuTags.BUTTON).performClick()
        rule.onNodeWithTag(AccountMenuTags.entry(id)).performClick()

        rule.waitUntilAtLeastOneExists(hasTestTag(UnlockFailedTags.PAGE), 5_000)
        rule.onNodeWithText("This phone can no longer decrypt your saved account. Restore it with your secret key, or remove it.").assertExists()
        rule.onNodeWithText("Restore with secret key").assertExists()
        rule.onNodeWithText("Retry").assertDoesNotExist()
        rule.onNodeWithText("Remove from this phone").performClick()
        rule.onNodeWithText("Remove").performClick()

        rule.waitUntilDoesNotExist(hasTestTag(UnlockFailedTags.PAGE), 5_000)
        rule.waitUntil(5_000) { graph.accountStore.registry.value.entry(id) == null }
        assertEquals(null, rnItem)
        assertEquals(other, (graph.auth.state.value as AuthState.SignedIn).credentials)
    }

    @Test
    fun anItemNoReadWillOpenOffersRestoreAndRemove() {
        keys.secretKeys.clear()
        start(keys)
        rule.waitUntilAtLeastOneExists(hasTestTag(UnlockFailedTags.PAGE), 5_000)
        rule.onNodeWithText("This phone can no longer decrypt your saved account. Restore it with your secret key, or remove it.").assertExists()
        rule.onNodeWithText("Retry").assertDoesNotExist()
        rule.onNodeWithText("Restore with secret key").assertExists()

        rule.onNodeWithText("Remove from this phone").performClick()
        rule.onNodeWithText("Remove this account from this phone?").assertExists()
        rule.onNodeWithText("Cancel").performClick()
        assertTrue("kept until confirmed", rnItem != null)

        rule.onNodeWithText("Remove from this phone").performClick()
        rule.onNodeWithText("Remove").performClick()
        rule.waitUntilDoesNotExist(hasTestTag(UnlockFailedTags.PAGE), 5_000)
        rule.onNodeWithText("Start").assertExists()
        assertEquals(null, rnItem)
    }

    @Test
    fun restoreWithSecretKeyOpensTheRestoreScreen() {
        keys.secretKeys.clear()
        start(keys)
        rule.waitUntilAtLeastOneExists(hasTestTag(UnlockFailedTags.PAGE), 5_000)
        rule.onNodeWithText("Restore with secret key").performClick()
        rule.waitUntilAtLeastOneExists(hasTestTag(RestoreTags.KEY_INPUT), 5_000)
    }

    private companion object {
        const val RN_ALIAS = "AES/GCM/NoPadding:key_v1:keystoreUnauthenticated"
    }
}
