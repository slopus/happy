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
import com.slopus.happy.agent.AccountLogin
import com.slopus.happy.agent.CredentialSource
import com.slopus.happy.agent.LoginRefreshError
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

/** Settings › Provider accounts, an account's page, and its sign-in and token pages (happy-agent API.md, "Provider sign-in"). */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
class ProviderAccountsTest {
    @get:Rule val rule = createComposeRule()

    private val now = 1_764_000_000_000L
    private val minute = 60_000L
    private val hour = 60 * minute

    /** Noon UTC on Nov 20 2025: Nov 20 wherever the test runs. */
    private val nov20 = 1_763_640_000_000L

    private fun error(status: Int?, code: String?, permanent: Boolean, since: Long = nov20, at: Long = now - 12 * minute) =
        LoginRefreshError(status, code, permanent, since, at)

    private val codex = ProviderAccount(
        "codex", null, "codex", ProviderCredential(CredentialSource.System, listOf("device", "browser"), acceptsToken = false),
        signIn = "signed_in", lastUsedAt = now - 4 * minute, login = AccountLogin(now - 2 * hour, now + 8 * 24 * hour, null), loginReported = true,
    )
    private val claude = ProviderAccount(
        "claude_work", "Claude (work)", "claude", ProviderCredential(CredentialSource.Internal, listOf("browser"), acceptsToken = true),
        signIn = "signed_in", plan = "Max", login = AccountLogin(now - 30 * minute, now + 7 * hour, null), loginReported = true,
    )
    private val grok = ProviderAccount("grok", null, "grok", ProviderCredential(CredentialSource.Configured, listOf("device"), acceptsToken = false), signIn = "signed_out", loginReported = true)
    private val claudeHome = claude.copy(id = "claude_home", name = "Claude (home)", plan = "Pro", signIn = "signed_out", login = AccountLogin(null, null, error(400, "invalid_grant", permanent = true)))
    private val codexTeam = codex.copy(
        id = "codex_team", name = "Codex (team)", credential = codex.credential.copy(source = CredentialSource.Internal), plan = "Team",
        login = AccountLogin(now - 21 * hour, now + 3 * hour, error(503, null, permanent = false)),
    )
    private val grokSide = grok.copy(id = "grok_side", name = "Grok (side)", signIn = null)
    private val claudeOld = claude.copy(id = "claude_old", name = "Claude (old)", plan = null, enabled = false)
    private val legacy = codex.copy(id = "codex_old", name = "Codex (old)", lastUsedAt = null, login = null, loginReported = false, checkedAt = now - 5 * minute)
    private val accounts = ProviderAccountsState.Loaded(listOf(codex, claude, grok))

    private fun signIn(account: ProviderAccount, installed: Boolean = true, email: String? = null, plan: String? = null, operation: SignInOperation? = null) =
        ProviderSignIn(account.id, account.type, installed, account.credential, email, plan, operation, version = "v1")

    private fun showAccounts(
        state: ProviderAccountsState = accounts,
        signIns: Map<String, ProviderSignIn> = emptyMap(),
        onOpen: (ProviderAccount) -> Unit = {},
    ) = rule.setHappyContent { ProviderAccountsScreen(state, signIns, now, onOpen = onOpen) }

    /** Every line a row can say, the first that applies, each account's dot on its icon. */
    @Test
    fun eachRowSaysTheFirstThingThatApplies() {
        showAccounts(ProviderAccountsState.Loaded(listOf(codex, claude, grok, claudeHome, codexTeam, grokSide, claudeOld, legacy)))
        rule.onNodeWithText("Provider accounts").assertExists()
        // The account's own name, else its assistant's, with its plan.
        rule.onNodeWithText("Codex").assertExists()
        rule.onNodeWithText("Claude (work) · Max").assertExists()
        rule.onNodeWithText("System login · Used 4m ago · refreshed 2h ago").assertExists()
        rule.onNodeWithText("Not used yet · refreshed 30m ago").assertExists()
        // Signed out without a refresh error: no date to give.
        rule.onNodeWithText("Needs sign-in").assertExists()
        rule.onNodeWithText("Needs sign-in since Nov 20").assertExists()
        // A failing refresh warns of a login that runs out within the day.
        rule.onNodeWithText("Couldn't refresh · HTTP 503 · last tried 12m ago\nLogin expires in 3h").assertExists()
        rule.onNodeWithText("Not used yet").assertExists()
        rule.onNodeWithText("Off").assertExists()
        // An older agent: only when usage last looked.
        rule.onNodeWithText("System login · Last checked 5m ago").assertExists()
        for (id in listOf("codex", "claude_work", "grok", "claude_home", "codex_team", "grok_side", "claude_old", "codex_old")) {
            rule.node(ProviderAccountsTags.dot(id)).assertExists()
        }
        // Nothing to press on a row but the row.
        rule.node(ProviderAccountsTags.signIn("codex")).assertDoesNotExist()
        rule.node(ProviderAccountsTags.token("claude_work")).assertDoesNotExist()
    }

    @Test
    fun aRowOpensItsAccount() {
        var opened: String? = null
        showAccounts(onOpen = { opened = it.id })
        rule.node(ProviderAccountsTags.account("claude_work")).performClick()
        assertEquals("claude_work", opened)
    }

    /** The settings card's rows: 16 in from each edge inside its 1 px border, as tall as their two lines. */
    @Test
    fun rowsAreSettingsRows() {
        showAccounts()
        val codexRow = rule.node(ProviderAccountsTags.account("codex")).bounds
        val claudeRow = rule.node(ProviderAccountsTags.account("claude_work")).bounds
        val dot = rule.node(ProviderAccountsTags.dot("codex")).bounds
        assertDp("card left", (16 + 1 / 3f).dp, codexRow.left)
        assertDp("card width", (379 - 2 / 3f).dp, codexRow.right - codexRow.left)
        // Title 24 and subtitle 20 inside 16 above and below.
        assertDp("row height", 76, codexRow.bottom - codexRow.top)
        assertTrue("rows follow each other", claudeRow.top >= codexRow.bottom)
        assertDp("dot", 12, dot.right - dot.left)
    }

    @Test
    fun loadingEmptyAndFailedSayWhatTheyAre() {
        var state: ProviderAccountsState by mutableStateOf<ProviderAccountsState>(ProviderAccountsState.Loading)
        rule.setHappyContent { ProviderAccountsScreen(state, emptyMap(), now) }
        rule.node(ProviderAccountsTags.LOADING).assertExists()
        state = ProviderAccountsState.Loaded(emptyList())
        rule.onNodeWithText("No accounts sign in with a subscription.").assertExists()
        state = ProviderAccountsState.Failed
        rule.onNodeWithText("Couldn't load the accounts.").assertExists()
        rule.onNodeWithText("Try again").assertExists()
    }

    private fun showAccount(
        account: ProviderAccount,
        signIn: ProviderSignIn? = null,
        ownerOnly: Boolean = false,
        onEnabled: (Boolean) -> Unit = {},
        onSignIn: () -> Unit = {},
        onToken: () -> Unit = {},
    ) = rule.setHappyContent { ProviderAccountScreen(account, signIn, ownerOnly, now, onEnabled = onEnabled, onSignIn = onSignIn, onToken = onToken) }

    @Test
    fun anAccountsPageSaysWhereItsLoginComesFromAndHowItsRefreshGoes() {
        val switched = mutableListOf<Boolean>()
        var signingIn = 0
        var token = 0
        showAccount(claude, signIn(claude, email = "ada@example.com", plan = "Max"), onEnabled = { switched += it }, onSignIn = { signingIn++ }, onToken = { token++ })
        // Name and plan, the vendor beside them.
        rule.onNodeWithText("Max", useUnmergedTree = true).assertExists()
        rule.onNodeWithText("Claude", useUnmergedTree = true).assertExists()
        rule.onNodeWithText("Source", useUnmergedTree = true).assertExists()
        rule.onNodeWithText("Signed in to Happy", useUnmergedTree = true).assertExists()
        rule.onNodeWithText("ada@example.com · Max", useUnmergedTree = true).assertExists()
        rule.onNodeWithText("30m ago", useUnmergedTree = true).assertExists()
        rule.onNodeWithText("In 7h", useUnmergedTree = true).assertExists()
        rule.node(ProviderAccountsTags.REFRESH_ERROR).assertDoesNotExist()
        rule.onNodeWithText("Signing in here gives this account a login only Happy uses, so it stops using the system login.", useUnmergedTree = true).assertExists()
        rule.node(ProviderAccountsTags.ENABLED).performClick()
        rule.node(ProviderAccountsTags.signIn("claude_work")).performScrollTo().performClick()
        rule.node(ProviderAccountsTags.token("claude_work")).performScrollTo().performClick()
        assertEquals(listOf(false), switched)
        assertEquals(1, signingIn)
        assertEquals(1, token)
    }

    @Test
    fun aFailingRefreshShowsItsCodeAndSinceWhen() {
        showAccount(claudeHome)
        rule.onNodeWithText("Last refresh error").assertExists()
        rule.onNodeWithText("invalid_grant · since Nov 20", useUnmergedTree = true).assertExists()
        rule.onNodeWithText("Never", useUnmergedTree = true).assertExists()
    }

    @Test
    fun anOlderAgentSaysOnlyWhenItLastChecked() {
        showAccount(legacy)
        rule.onNodeWithText("Using system login", useUnmergedTree = true).assertExists()
        rule.node(ProviderAccountsTags.LAST_CHECKED).assertExists()
        rule.onNodeWithText("5m ago", useUnmergedTree = true).assertExists()
        rule.node(ProviderAccountsTags.LAST_REFRESH).assertDoesNotExist()
        rule.node(ProviderAccountsTags.EXPIRES).assertDoesNotExist()
        rule.node(ProviderAccountsTags.token("codex_old")).assertDoesNotExist()
    }

    @Test
    fun aRunningSignInSaysSoOnItsRow() {
        showAccount(codex, signIn(codex, operation = SignInOperation("op1", SignInOperation.Status.Waiting, null)))
        rule.onNodeWithText("In progress", useUnmergedTree = true).assertExists()
    }

    @Test
    fun aTeamMemberSeesWhyNothingCanChange() {
        showAccount(claude, ownerOnly = true)
        rule.node(ProviderAccountsTags.ENABLED).assertIsNotEnabled()
        rule.node(ProviderAccountsTags.signIn("claude_work")).assertIsNotEnabled()
        rule.node(ProviderAccountsTags.token("claude_work")).assertIsNotEnabled()
        rule.onNodeWithText("Only the team owner can change how accounts sign in.", substring = true, useUnmergedTree = true).assertExists()
    }

    @Test
    fun aBrowserOnlyAccountCantSignInFromThePhone() {
        val browserOnly = codex.copy(credential = codex.credential.copy(methods = listOf("browser")))
        showAccount(browserOnly)
        rule.onNodeWithText("This account signs in on the computer, not from a phone.", substring = true, useUnmergedTree = true).assertExists()
        rule.node(ProviderAccountsTags.signIn("codex")).assertIsNotEnabled()
    }

    @Test
    fun aMissingProgramSaysWhichButATokenNeedsNone() {
        showAccount(claude, signIn(claude, installed = false))
        rule.onNodeWithText("Install Claude Code on the computer to sign in.", substring = true, useUnmergedTree = true).assertExists()
        rule.node(ProviderAccountsTags.signIn("claude_work")).assertIsNotEnabled()
        rule.node(ProviderAccountsTags.token("claude_work")).assertIsEnabled()
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
