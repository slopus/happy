package com.slopus.happy.ui.connection

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertHeightIsAtLeast
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.isHeading
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.connection.AgentConnection
import com.slopus.happy.connection.OAuthMethod
import com.slopus.happy.connection.ServerAuthException
import com.slopus.happy.connection.ServerSignInState
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertActionsLabelled
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** Team server sign-in through each state, under the standard header, PairingScreen's column. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ServerSignInScreenTest {
    @get:Rule val rule = createComposeRule()

    private val method = OAuthMethod("jwt", "Acme SSO", "https://sso.acme.example/authorize", "https://sso.acme.example/token", clientId = "happy")

    @Test
    fun eachStateShowsWhatToDoNext() {
        var state by mutableStateOf<ServerSignInState>(ServerSignInState.Checking("https://happy.acme.example"))
        val names = mutableListOf<String>()
        var browser = 0
        var retried = 0
        rule.setHappyContent {
            ServerSignInScreen(state, onOpenBrowser = { browser++ }, onSubmitName = { names += it }, onRetry = { retried++ }, onBack = {})
        }
        rule.onNode(isHeading(), useUnmergedTree = true).assertExists()
        rule.onNodeWithText("Sign in to a server").assertExists()
        rule.node(ServerSignInTags.SPINNER).assertExists()
        rule.onNodeWithText("happy.acme.example", substring = true).assertExists()

        state = ServerSignInState.Ready("https://happy.acme.example", method)
        rule.onNodeWithText("Continue with Acme SSO").assertExists()
        rule.onNodeWithText("sso.acme.example", substring = true).assertExists()
        rule.assertActionsLabelled()
        rule.node(ServerSignInTags.BROWSER).performClick()

        state = ServerSignInState.InBrowser("https://happy.acme.example", method)
        rule.node(ServerSignInTags.SPINNER).assertExists()
        rule.node(ServerSignInTags.BROWSER).performClick()
        assertEquals(2, browser)

        state = ServerSignInState.NeedsName("https://happy.acme.example")
        // The field: 24 from each side of the 411 phone, at least 44 high.
        val field = rule.node(ServerSignInTags.NAME).assertHeightIsAtLeast(ServerSignInSpec.fieldMinHeight).bounds
        assertEquals(24f, field.left.value, 0.34f)
        assertEquals(411f - 24f, field.right.value, 0.34f)
        rule.node(ServerSignInTags.CONTINUE).assertIsNotEnabled()
        rule.node(ServerSignInTags.NAME).performTextInput("Steve")
        rule.node(ServerSignInTags.CONTINUE).performClick()
        assertEquals(listOf("Steve"), names)

        state = ServerSignInState.Failed("https://happy.acme.example", ServerAuthException.Reason.EdgeBlocked)
        rule.onNodeWithText("/v0/authentication", substring = true).assertExists()
        rule.node(ServerSignInTags.RETRY).performClick()
        assertEquals(1, retried)

        state = ServerSignInState.Failed("https://happy.acme.example", ServerAuthException.Reason.WrongServer)
        rule.onNodeWithText("This code doesn't match the server it points to.", substring = true).assertExists()

        state = ServerSignInState.Done(AgentConnection(id = "c1", name = "Acme", addedAt = 0, server = "https://happy.acme.example"))
        rule.node(ServerSignInTags.SPINNER).assertExists()
    }
}
