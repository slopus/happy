package com.slopus.happy.ui

import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isDialog
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextReplacement
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.AppGraph
import com.slopus.happy.auth.AuthState
import com.slopus.happy.crypto.Base64Variant
import com.slopus.happy.crypto.SecretKeyBackup
import com.slopus.happy.crypto.encodeBase64
import com.slopus.happy.testing.FakeHappyServer
import com.slopus.happy.testing.SoftwareKeys
import com.slopus.happy.ui.home.HomeTags
import com.slopus.happy.ui.onboarding.RestoreTags
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** The whole app against an in-memory server: sign up or restore, sync, sign out. */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class AppFlowTest {
    @get:Rule
    val rule = createComposeRule()

    private lateinit var server: FakeHappyServer
    private lateinit var graph: AppGraph

    @Before
    fun setUp() {
        server = FakeHappyServer().start()
        graph = AppGraph(
            context = ApplicationProvider.getApplicationContext(),
            clientId = "android/test",
            defaultServerUrl = server.url,
            secureStoreKeys = SoftwareKeys(),
            databaseName = null,
        )
        rule.setContent { HappyApp(graph) }
    }

    @After
    fun tearDown() = server.close()

    // A new account has no computer, so the link page takes the home over (index.tsx); its gear logs out.
    @Test
    fun createAccountThenLogout() {
        rule.onNodeWithText("Create account").performClick()
        rule.waitUntilAtLeastOneExists(hasTestTag(HomeTags.LINK), 5_000)
        assertTrue(graph.auth.state.value is AuthState.SignedIn)

        rule.onNodeWithContentDescription("Settings").performClick()
        rule.onNodeWithText("Log out and start over").performScrollTo().performClick()
        rule.onNode(hasText("Logout") and hasClickAction() and hasAnyAncestor(isDialog())).performClick()

        rule.waitUntilAtLeastOneExists(hasText("Create account"), 5_000)
        assertEquals(AuthState.SignedOut, graph.auth.state.value)
        assertNull(graph.store.profile())
    }

    @Test
    fun restoreWithSecretKeyThenSync() {
        // With no computer the link page takes the home over, and the filter only shows while loading.
        server.addMachine("m1")
        server.addSession("s1", updatedAt = 100)
        server.setSettings(buildJsonObject { put("analyticsOptOut", true) }, version = 2)

        rule.onNodeWithText("Restore existing account").performClick()
        rule.onNodeWithText("Use a secret key instead").performClick()
        rule.onNodeWithTag(RestoreTags.KEY_INPUT)
            .performTextReplacement(SecretKeyBackup.format(encodeBase64(server.secret, Base64Variant.Url)))
        rule.onNodeWithText("Restore").performClick()

        rule.waitUntilAtLeastOneExists(hasTestTag(HomeTags.FILTER), 5_000)
        rule.waitUntil(5_000) { graph.store.sessionIds() == setOf("s1") && graph.store.settings() != null }
        assertEquals(server.publicKey, server.authenticatedKeys.single())
    }

    @Test
    fun aWrongSecretKeyShowsTheError() {
        rule.onNodeWithText("Restore existing account").performClick()
        rule.onNodeWithText("Use a secret key instead").performClick()
        rule.onNodeWithTag(RestoreTags.KEY_INPUT).performTextReplacement("AAAAA-BBBBB")
        rule.onNodeWithText("Restore").performClick()
        rule.waitUntilAtLeastOneExists(hasText("Invalid secret key. Please check and try again."), 5_000)
        assertEquals(AuthState.SignedOut, graph.auth.state.value)
    }
}
