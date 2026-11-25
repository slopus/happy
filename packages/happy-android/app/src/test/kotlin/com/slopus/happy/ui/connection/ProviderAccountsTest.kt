package com.slopus.happy.ui.connection

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.unit.dp
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.agent.CredentialSource
import com.slopus.happy.agent.ProviderAccount
import com.slopus.happy.agent.ProviderAccountsState
import com.slopus.happy.agent.ProviderCredential
import com.slopus.happy.agent.ProviderSignIn
import com.slopus.happy.agent.SignInFailure
import com.slopus.happy.agent.SignInOperation
import com.slopus.happy.agent.SignInStep
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.components.ItemSpec
import com.slopus.happy.ui.node
import com.slopus.happy.ui.settings.AboutInfo
import com.slopus.happy.ui.settings.SettingsFixtures
import com.slopus.happy.ui.settings.SettingsProfile
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/** Settings › Provider accounts and its sign-in and token pages (happy-agent API.md, "Provider sign-in"). */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
class ProviderAccountsTest {
    @get:Rule val rule = createComposeRule()

    private val codex = ProviderAccount("codex", null, "codex", ProviderCredential(CredentialSource.System, listOf("device", "browser"), acceptsToken = false))
    private val claude = ProviderAccount("claude_work", "Claude (work)", "claude", ProviderCredential(CredentialSource.Internal, listOf("browser"), acceptsToken = true))
    private val grok = ProviderAccount("grok", null, "grok", ProviderCredential(CredentialSource.Configured, listOf("device"), acceptsToken = false), signedOut = true)
    private val accounts = ProviderAccountsState.Loaded(listOf(codex, claude, grok))

    private fun signIn(account: ProviderAccount, installed: Boolean = true, email: String? = null, plan: String? = null, operation: SignInOperation? = null) =
        ProviderSignIn(account.id, account.type, installed, account.credential, email, plan, operation, version = "v1")

    private fun showAccounts(
        state: ProviderAccountsState = accounts,
        signIns: Map<String, ProviderSignIn> = mapOf("claude_work" to signIn(claude, email = "ada@example.com", plan = "Max")),
        ownerOnly: Boolean = false,
        onSignIn: (ProviderAccount) -> Unit = {},
        onToken: (ProviderAccount) -> Unit = {},
    ) = rule.setHappyContent { ProviderAccountsScreen(state, signIns, ownerOnly, onSignIn = onSignIn, onToken = onToken) }

    @Test
    fun eachAccountSaysWhereItsLoginComesFromAndHowToChangeIt() {
        var signingIn: String? = null
        var token: String? = null
        showAccounts(onSignIn = { signingIn = it.id }, onToken = { token = it.id })
        rule.onNodeWithText("Provider accounts").assertExists()
        // Headed by the account's own name, else its assistant's.
        rule.onNodeWithText("CODEX").assertExists()
        rule.onNodeWithText("CLAUDE (WORK)").assertExists()
        rule.onNodeWithText("GROK").assertExists()
        rule.onNodeWithText("Using system login").assertExists()
        rule.onNodeWithText("Signed in to Happy").assertExists()
        rule.onNodeWithText("ada@example.com · Max").assertExists()
        rule.onNodeWithText("Configured in config file").assertExists()
        // Usage says Grok's doesn't work now.
        rule.onNodeWithText("Signed out").assertExists()
        // Every card says what signing in does.
        assertEquals(3, rule.onAllNodes(androidx.compose.ui.test.hasText("Signing in here gives this account a login only Happy uses, so it stops using the system login."), useUnmergedTree = true).fetchSemanticsNodes().size)
        // Only Claude takes a token.
        rule.node(ProviderAccountsTags.token("claude_work")).assertExists()
        rule.node(ProviderAccountsTags.token("codex")).assertDoesNotExist()
        rule.node(ProviderAccountsTags.signIn("codex")).performClick()
        rule.node(ProviderAccountsTags.token("claude_work")).performClick()
        assertEquals("codex", signingIn)
        assertEquals("claude_work", token)
    }

    /** The settings card's rows: 16 in from each edge inside its 1 px border, the source row as tall as its two lines, the action rows 56. */
    @Test
    fun rowsAreSettingsRows() {
        showAccounts()
        val source = rule.node(ProviderAccountsTags.source("claude_work")).bounds
        val action = rule.node(ProviderAccountsTags.signIn("claude_work")).bounds
        val token = rule.node(ProviderAccountsTags.token("claude_work")).bounds
        assertDp("card left", (16 + 1 / 3f).dp, source.left)
        assertDp("card width", (379 - 2 / 3f).dp, source.right - source.left)
        // Title 24 and subtitle 20 inside 16 above and below.
        assertDp("source height", 76, source.bottom - source.top)
        assertDp("sign in height", ItemSpec.minHeight, action.bottom - action.top)
        assertTrue("actions follow the source row", action.top >= source.bottom && token.top >= action.bottom)
        assertDp("sign in left", (16 + 1 / 3f).dp, action.left)
    }

    @Test
    fun aRunningSignInSaysSoOnItsRow() {
        showAccounts(signIns = mapOf("codex" to signIn(codex, operation = SignInOperation("op1", SignInOperation.Status.Waiting, null))))
        rule.onNodeWithText("In progress").assertExists()
    }

    @Test
    fun aTeamMemberSeesWhyNothingCanChange() {
        showAccounts(ownerOnly = true)
        rule.node(ProviderAccountsTags.signIn("codex")).assertIsNotEnabled()
        rule.node(ProviderAccountsTags.token("claude_work")).assertIsNotEnabled()
        rule.onAllNodes(androidx.compose.ui.test.hasText("Only the team owner can change how accounts sign in."), useUnmergedTree = true)
            .fetchSemanticsNodes().let { assertEquals(3, it.size) }
    }

    @Test
    fun aMissingProgramOrABrowserOnlyAccountCantSignInFromThePhone() {
        val browserOnly = codex.copy(credential = codex.credential.copy(methods = listOf("browser")))
        showAccounts(
            state = ProviderAccountsState.Loaded(listOf(browserOnly, claude, grok)),
            signIns = mapOf("grok" to signIn(grok, installed = false), "claude_work" to signIn(claude, installed = false)),
        )
        rule.onNodeWithText("This account signs in on the computer, not from a phone.", useUnmergedTree = true).assertExists()
        rule.onNodeWithText("Install Grok on the computer to sign in.", useUnmergedTree = true).assertExists()
        rule.onNodeWithText("Install Claude Code on the computer to sign in.", useUnmergedTree = true).assertExists()
        rule.node(ProviderAccountsTags.signIn("codex")).assertIsNotEnabled()
        rule.node(ProviderAccountsTags.signIn("grok")).assertIsNotEnabled()
        // A token needs no program.
        rule.node(ProviderAccountsTags.token("claude_work")).assertIsEnabled()
    }

    @Test
    fun loadingEmptyAndFailedSayWhatTheyAre() {
        var state: ProviderAccountsState by mutableStateOf<ProviderAccountsState>(ProviderAccountsState.Loading)
        rule.setHappyContent { ProviderAccountsScreen(state, emptyMap(), ownerOnly = false) }
        rule.node(ProviderAccountsTags.LOADING).assertExists()
        state = ProviderAccountsState.Loaded(emptyList())
        rule.onNodeWithText("No accounts sign in with a subscription.").assertExists()
        state = ProviderAccountsState.Failed
        rule.onNodeWithText("Couldn't load the accounts.").assertExists()
        rule.onNodeWithText("Try again").assertExists()
    }

    private var step: SignInStep by mutableStateOf<SignInStep>(SignInStep.Starting)

    private fun showSignIn(onOpen: (String) -> Unit = {}, onCode: (String) -> Unit = {}, onCancel: () -> Unit = {}, onRetry: () -> Unit = {}) =
        rule.setHappyContent { ProviderSignInScreen("Codex", "Codex", step, onOpen = onOpen, onCode = onCode, onCancel = onCancel, onRetry = onRetry) }

    /** A device code as Happy Cloud's ChatGPT sign-in draws it: the code, Copy and Open centred in the card. */
    @Test
    fun aDeviceCodeIsCopiedAndItsPageOpened() {
        var opened: String? = null
        var cancelled = false
        step = SignInStep.Device("https://auth.openai.com/codex/device", "K7QF-9WXM")
        showSignIn(onOpen = { opened = it }, onCancel = { cancelled = true })
        rule.onNodeWithText("Sign in again").assertExists()
        rule.onNodeWithText("Enter this code on the sign-in page").assertExists()
        rule.onNodeWithText("Waiting for you to finish…").assertExists()
        val code = rule.node(ProviderAccountsTags.CODE).bounds
        val copy = rule.node(ProviderAccountsTags.COPY).bounds
        assertDp("code centred", (411f / 2).dp, (code.left + code.right) / 2)
        assertDp("copy centred", (411f / 2).dp, (copy.left + copy.right) / 2)
        assertTrue("copy under the code", copy.top > code.bottom)
        rule.node(ProviderAccountsTags.COPY).performClick()
        rule.onNodeWithText("Copied").assertExists()
        rule.node(ProviderAccountsTags.OPEN).performClick()
        assertEquals("https://auth.openai.com/codex/device", opened)
        rule.node(ProviderAccountsTags.CANCEL).performClick()
        assertTrue(cancelled)
    }

    @Test
    fun claudesCodeIsPastedBackAndChecked() {
        val sent = mutableListOf<String>()
        step = SignInStep.PasteCode("https://claude.ai/oauth/authorize", checking = false)
        showSignIn(onCode = { sent += it })
        rule.onNodeWithText("Open the sign-in page, then paste the code it shows.").assertExists()
        rule.node(ProviderAccountsTags.SUBMIT).assertIsNotEnabled()
        rule.node(ProviderAccountsTags.FIELD).performTextInput("abc#123")
        rule.node(ProviderAccountsTags.SUBMIT).performClick()
        assertEquals(listOf("abc#123"), sent)
        step = SignInStep.PasteCode("https://claude.ai/oauth/authorize", checking = true)
        rule.onNodeWithText("Checking…", useUnmergedTree = true).assertExists()
    }

    @Test
    fun aBrowserSignInStartedElsewhereFinishesOnTheComputer() {
        step = SignInStep.OnComputer("http://localhost:1455/auth")
        showSignIn()
        rule.onNodeWithText("This sign-in finishes in a browser on the computer. Finish it there, or cancel it.", useUnmergedTree = true).assertExists()
        rule.node(ProviderAccountsTags.CANCEL).assertExists()
    }

    @Test
    fun theEndSaysWhoSignedInOrWhyItDidntInTheAgentsWords() {
        var retried = 0
        step = SignInStep.Done("ada@example.com", "Pro")
        showSignIn(onRetry = { retried++ })
        rule.onNodeWithText("Signed in").assertExists()
        rule.onNodeWithText("ada@example.com · Pro", useUnmergedTree = true).assertExists()
        rule.node(ProviderAccountsTags.CANCEL).assertDoesNotExist()
        step = SignInStep.Failed(SignInFailure.Expired, "The device code expired before the sign-in finished.")
        rule.onNodeWithText("Sign-in expired").assertExists()
        rule.onNodeWithText("The device code expired before the sign-in finished.", useUnmergedTree = true).assertExists()
        rule.node(ProviderAccountsTags.RETRY).performClick()
        assertEquals(1, retried)
        step = SignInStep.Failed(SignInFailure.SaveFailed, null)
        rule.onNodeWithText("Couldn't save the sign-in").assertExists()
        rule.onNodeWithText("The account keeps the login it had.", useUnmergedTree = true).assertExists()
        step = SignInStep.Failed(SignInFailure.OwnerOnly, "Only the team owner may.")
        rule.onNodeWithText("Sign-in failed").assertExists()
        rule.onNodeWithText("Only the team owner can change how accounts sign in.", useUnmergedTree = true).assertExists()
        rule.node(ProviderAccountsTags.RETRY).assertDoesNotExist()
    }

    @Test
    fun aSetupTokenIsSavedOnceAndARefusalSaysWhy() {
        val saved = mutableListOf<String>()
        var phase: TokenPhase by mutableStateOf<TokenPhase>(TokenPhase.Editing)
        rule.setHappyContent { ProviderTokenScreen("Claude (work)", phase, onSave = { saved += it }) }
        rule.onNodeWithText("Update token").assertExists()
        rule.onNodeWithText("Paste a token from `claude setup-token` on your computer.", useUnmergedTree = true).assertExists()
        rule.node(ProviderAccountsTags.SUBMIT).assertIsNotEnabled()
        rule.node(ProviderAccountsTags.FIELD).performTextInput("sk-ant-oat01-abc")
        rule.node(ProviderAccountsTags.SUBMIT).performClick()
        assertEquals(listOf("sk-ant-oat01-abc"), saved)
        phase = TokenPhase.Failed("That isn't a Claude setup token.")
        rule.onNodeWithText("Couldn't update the token").assertExists()
        rule.onNodeWithText("That isn't a Claude setup token.", useUnmergedTree = true).assertExists()
        phase = TokenPhase.Done
        rule.onNodeWithText("Token updated").assertExists()
    }

    @Test
    fun settingsListsProviderAccountsAfterAgentsWhereTheAgentOffersIt() {
        var opened = false
        var index = emptyList<AgentSettingsRow>()
        rule.setHappyContent {
            index = agentSettingsIndex(providerAccountsAvailable = true)
            AgentConnectionSettingsScreen(
                profile = SettingsProfile("agent-connection-1", "Studio", "Connected"),
                accounts = SettingsFixtures.accounts,
                actions = AgentSettingsActions(onAgents = {}, onUsage = {}, onProviderAccounts = { opened = true }),
                about = AboutInfo("1.8.0 (412)"),
            )
        }
        val ids = index.map { it.id }
        assertEquals(ids.indexOf(AgentAgentsTags.ROW) + 1, ids.indexOf(ProviderAccountsTags.ROW))
        assertEquals(ids.indexOf(ProviderAccountsTags.ROW) + 1, ids.indexOf(AgentUsageTags.ROW))
        rule.node(ProviderAccountsTags.ROW).performScrollTo().performClick()
        assertTrue(opened)
    }
}
