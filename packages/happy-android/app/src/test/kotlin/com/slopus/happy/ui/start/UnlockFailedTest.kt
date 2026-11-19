package com.slopus.happy.ui.start

import android.content.Context
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.hasTestTag
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
        override fun secretKey(alias: String): SecretKey? = if (failing) throw IllegalStateException("keystore2") else keys.secretKey(alias)
    }

    @Before
    fun setUp() {
        for (name in listOf(ExpoSecureStore.PREFS_NAME, AccountStore.PREFS_NAME, AccountStore.CREDENTIALS_PREFS_NAME)) {
            context.getSharedPreferences(name, Context.MODE_PRIVATE).edit().clear().commit()
        }
        SecureStoreCredentialStore(ExpoSecureStore(prefs, keys)).write(credentials)
        graph = AppGraph(context, "android/test", "https://api.cluster-fluster.com", keystore, databaseName = null)
        rule.setContent { HappyApp(graph) }
    }

    @After
    fun tearDown() {
        runBlocking { graph.account.value?.stop(); graph.awaitRemovals() }
    }

    @Test
    fun retryOpensTheAccountOnceTheKeystoreAnswers() {
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
    fun useAnotherAccountLeavesTheItem() {
        val item = rnItem
        rule.waitUntilAtLeastOneExists(hasTestTag(UnlockFailedTags.PAGE), 5_000)
        rule.onNodeWithText("Use another account").performClick()
        rule.waitUntilAtLeastOneExists(hasTestTag(InstallDesktopTags.CONTENT), 5_000)
        assertEquals(item, rnItem)
        assertTrue(graph.locked.value != null)
        rule.onNodeWithTag(UnlockFailedTags.PAGE).assertDoesNotExist()
    }
}
