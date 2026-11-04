package com.slopus.happy.ui.connection

import android.content.Context
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isDialog
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.AppGraph
import com.slopus.happy.accounts.AccountRemovals
import com.slopus.happy.accounts.AccountStore
import com.slopus.happy.auth.AuthCredentials
import com.slopus.happy.auth.AuthState
import com.slopus.happy.auth.ExpoSecureStore
import com.slopus.happy.config.ServerConfig
import com.slopus.happy.crypto.Base64Variant
import com.slopus.happy.crypto.encodeBase64
import com.slopus.happy.testing.FakeHappyServer
import com.slopus.happy.testing.SoftwareKeys
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.home.AccountMenu
import com.slopus.happy.ui.home.AccountMenuEntry
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import com.slopus.happy.ui.settings.AccountsCard
import com.slopus.happy.ui.settings.SettingsPageTags
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** The real accounts-card callback removes the held row, not whichever CLI account is open. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class InactiveAccountRemovalTest {
    @get:Rule val rule = createComposeRule()
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private val first = FakeHappyServer().start()
    private val second = FakeHappyServer(ByteArray(32) { (it + 33).toByte() }).start()
    private var graph: AppGraph? = null

    @Before fun clearAccounts() {
        for (name in listOf(ExpoSecureStore.PREFS_NAME, AccountStore.PREFS_NAME, AccountStore.CREDENTIALS_PREFS_NAME, AccountRemovals.PREFS_NAME, ServerConfig.PREFS_NAME)) {
            context.getSharedPreferences(name, Context.MODE_PRIVATE).edit().clear().commit()
        }
    }

    @After fun close() {
        graph?.let { runBlocking { it.account.value?.stop(); it.awaitRemovals() } }
        first.close()
        second.close()
    }

    @Test fun confirmingTheInactiveCliRowKeepsTheSelectedAccountSignedIn() {
        val graph = AppGraph(context, "android/test", first.url, SoftwareKeys(), databaseName = null).also { this.graph = it }
        val a = graph.accountStore.signIn(AuthCredentials(first.token, encodeBase64(first.secret, Base64Variant.Url)), first.url)
        val b = graph.accountStore.signIn(AuthCredentials(second.token, encodeBase64(second.secret, Base64Variant.Url)), second.url)
        runBlocking { graph.auth.reload() }
        val signedIn = graph.auth.state.value as AuthState.SignedIn
        val menu = AccountMenu(listOf(AccountMenuEntry(a, "First"), AccountMenuEntry(b, "Second", active = true)))
        rule.setHappyContent { AccountsCard(menu, rememberAccountsCardActions(graph)) }
        rule.node(SettingsPageTags.account(a)).performTouchInput { longClick() }
        rule.onNodeWithText("Logout").performClick()
        rule.onNodeWithText("Sign out of Happy CLI?").assertIsDisplayed()
        assertNotNull(graph.accountStore.registry.value.entry(a))
        rule.onNode(hasText("Logout") and hasAnyAncestor(isDialog())).performClick()
        rule.waitUntil(5_000) { graph.accountStore.registry.value.entry(a) == null }
        assertEquals(listOf(b), graph.accountStore.registry.value.entries.map { it.id })
        assertEquals(b, graph.accountStore.registry.value.activeId)
        assertEquals(signedIn, graph.auth.state.value)
    }
}