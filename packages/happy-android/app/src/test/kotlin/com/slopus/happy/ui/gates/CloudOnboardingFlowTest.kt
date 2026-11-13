package com.slopus.happy.ui.gates

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.onboarding.CloudOnboarding
import com.slopus.happy.onboarding.OnboardingGate
import com.slopus.happy.onboarding.OnboardingGate.Kind
import com.slopus.happy.onboarding.OnboardingGate.Requirement
import com.slopus.happy.onboarding.OnboardingGate.Scope
import com.slopus.happy.onboarding.OnboardingGate.Status
import com.slopus.happy.onboarding.OnboardingPlan
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.connection.CloudTags
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/** The onboarding flow's screens, each from the plan's step, doing what the server is asked. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
class CloudOnboardingFlowTest {
    @get:Rule val rule = createComposeRule()

    private val asked = mutableListOf<String>()
    private fun actions(notNow: Boolean = true, checkFails: Boolean = false) = OnboardingActions(
        skip = { asked += "skip $it" },
        check = { asked += "check"; if (checkFails) error("offline") },
        saveName = { asked += "name $it" },
        savePhoto = { asked += "photo" },
        finish = { asked += "finish" },
        web = "https://acme.example/",
        onNotNow = if (notNow) ({ asked += "notNow" }) else null,
    )

    private fun show(onboarding: CloudOnboarding, actions: OnboardingActions = actions()) {
        val plan = OnboardingPlan.of(onboarding)
        rule.setHappyContent {
            CloudOnboardingFlow(onboarding, plan.step(showing = true)!!, if (plan.count > 1) plan.progress else null, "@acme", "acme", "Olga", null, meets = true, actions = actions)
        }
    }

    @Test
    fun aPaymentGateSendsThemToTheirComputerAndSkipsOnlyWhileOptional() {
        show(CloudOnboarding(false, gates = listOf(OnboardingGate("paymentMethod", Scope.Server, Requirement.Optional, Status.Open, kind = Kind.PaymentMethod))))
        rule.onNodeWithText("Finish on your computer").assertIsDisplayed()
        rule.onNodeWithText("Adding a payment method is done in Happy on your computer. Come back here when it's done.").assertIsDisplayed()
        // The app links to no payment: Check again reads the gate.
        assertEquals(0, rule.onAllNodesWithText("Open on the web").fetchSemanticsNodes().size)
        rule.onNodeWithText("Check again").performClick()
        rule.waitForIdle()
        rule.onNodeWithText("Skip for now").performClick()
        rule.waitForIdle()
        assertEquals(listOf("check", "skip paymentMethod"), asked)
    }

    @Test
    fun aRequiredPaymentGateHasNoSkipAndNoWayBack() {
        show(CloudOnboarding(false, gates = listOf(OnboardingGate("payment", Scope.Server, Requirement.Required, Status.Open, kind = Kind.Payment))), actions(notNow = false))
        rule.onNodeWithText("Check again").assertIsDisplayed()
        assertEquals(0, rule.onAllNodesWithText("Skip for now").fetchSemanticsNodes().size)
        assertEquals(0, rule.onAllNodesWithTag(com.slopus.happy.ui.components.HeaderTags.LEFT).fetchSemanticsNodes().size)
    }

    @Test
    fun waitingNamesWhatTheAdminHasToDoAndChecksAgain() {
        show(
            CloudOnboarding(false, gates = listOf(OnboardingGate("paymentMethod", Scope.Server, Requirement.Required, Status.Open, canComplete = false, kind = Kind.PaymentMethod))),
            actions(notNow = false, checkFails = true),
        )
        rule.onNodeWithText("Waiting for your admin").assertIsDisplayed()
        rule.onNodeWithText("Someone who manages this server has to finish setting it up first: adding a payment method.").assertIsDisplayed()
        rule.onNodeWithText("Check again").performClick()
        rule.waitForIdle()
        assertEquals(listOf("check"), asked)
        rule.onNodeWithTag(CloudOnboardingTags.PROBLEM).assertIsDisplayed()
        rule.onNodeWithText("Couldn't reach the server. Try again.").assertIsDisplayed()
    }

    @Test
    fun aBlockingGateThisAppDoesntKnowAsksForAnUpdate() {
        show(CloudOnboarding(false, gates = listOf(OnboardingGate("sso", Scope.Member, Requirement.Required, Status.Open, kind = Kind.Unknown))), actions(notNow = false))
        rule.onNodeWithText("Update Happy to continue").assertIsDisplayed()
        rule.onNodeWithText("Open Google Play").assertIsDisplayed()
    }

    @Test
    fun theFinishMeetsTheAdminBotByName() {
        val bot = Kind.AdminBot("b1", "a1", "Jarvis", "v1", null, emptyList(), null, null)
        show(CloudOnboarding(true, gates = listOf(OnboardingGate("adminBot", Scope.Server, Requirement.Optional, Status.Done, kind = bot))))
        rule.onNodeWithText("You're all set").assertIsDisplayed()
        rule.onNodeWithTag(CloudTags.PRIMARY).performClick()
        rule.waitForIdle()
        rule.onNodeWithText("Meet Jarvis").assertIsDisplayed()
        assertEquals(listOf("finish"), asked)
    }

    @Test
    fun anOptionalPhotoIsSkippedAndTheProgressShows() {
        show(
            CloudOnboarding(
                false,
                gates = listOf(
                    OnboardingGate("profile", Scope.Member, Requirement.Required, Status.Done, kind = Kind.Profile),
                    OnboardingGate("avatar", Scope.Member, Requirement.Optional, Status.Open, kind = Kind.Avatar),
                ),
            ),
        )
        rule.onNodeWithText("Add a photo").assertIsDisplayed()
        rule.onNodeWithTag(CloudOnboardingTags.PROGRESS).assertIsDisplayed()
        rule.onNodeWithText("Skip for now").performClick()
        rule.waitForIdle()
        assertEquals(listOf("skip avatar"), asked)
    }

    @Test
    fun theAdminBotKeepsItsNameOrTheOneTyped() {
        val renamed = mutableListOf<String>()
        val bot = Kind.AdminBot("b1", "a1", "Chief of Staff", "v1", null, emptyList(), null, "It has expanded capabilities.")
        val actions = OnboardingActions(
            skip = {}, check = {}, saveName = {}, savePhoto = {}, finish = {}, web = null, onNotNow = null,
            renameBot = { b, name -> renamed += "${b.botId} $name" },
        )
        show(CloudOnboarding(false, gates = listOf(OnboardingGate("adminBot", Scope.Server, Requirement.Optional, Status.Open, kind = bot))), actions)
        rule.onNodeWithText("Name your admin bot").assertIsDisplayed()
        rule.onNodeWithText("It has expanded capabilities.").assertIsDisplayed()
        rule.onNodeWithTag(CloudTags.PRIMARY).performClick()
        rule.waitForIdle()
        assertEquals(listOf("b1 Chief of Staff"), renamed)
    }

    @Test
    fun aRoleThatCantAddProvidersIsToldSo() {
        val actions = OnboardingActions(
            skip = {}, check = {}, saveName = {}, savePhoto = {}, finish = {}, web = null, onNotNow = null,
            inference = InferenceHost(offer = { error("not asked") }, custom = false, allowed = false, open = {}),
        )
        show(CloudOnboarding(false, gates = listOf(OnboardingGate("inference", Scope.Server, Requirement.Required, Status.Open, kind = Kind.Inference(emptyList(), freeModel = true)))), actions)
        // Required: the free model isn't offered as a way around it.
        rule.onNodeWithText("Your agents think with a model you connect: ChatGPT, Claude, Grok, or your own endpoint.").assertIsDisplayed()
        rule.onNodeWithText("Connect a provider").performClick()
        rule.onNodeWithText("Your role can't connect providers. Ask your admin.").assertIsDisplayed()
    }

    @Test
    fun theNeededPluginsComeFirstThenTheCatalogsOthers() {
        val gate = Kind.Plugins(listOf("github"), listOf(Kind.Plugins.Plugin("github", "GitHub", required = true, active = false)))
        fun plugin(id: String) = com.slopus.happy.plugins.Plugin(id, id, id.replaceFirstChar { it.uppercase() }, "", "1", null, emptyList(), true, emptyList(), com.slopus.happy.plugins.Installability.Installable, false)
        val snapshot = com.slopus.happy.plugins.PluginsSnapshot(
            listOf(plugin("linear"), plugin("github")),
            listOf(com.slopus.happy.plugins.PluginInstallation("i1", "github", "GitHub", 1, null, com.slopus.happy.plugins.InstallationStatus.Active, null, null, true)),
            canManage = true,
        )
        val rows = pluginRows(gate, com.slopus.happy.plugins.PluginsState.Loaded(snapshot))
        assertEquals(listOf("github" to true, "linear" to false), rows.map { it.id to it.active })
        assertEquals(listOf(true, false), rows.map { it.required })
        // Before the catalog answers: the gate's own word.
        assertEquals(listOf(PluginRow("github", "github", "GitHub", required = true, active = false)), pluginRows(gate, com.slopus.happy.plugins.PluginsState.Loading))
    }

    private fun teammates(invite: suspend (String?) -> com.slopus.happy.onboarding.TeamInvite, shared: MutableList<String>, holds: MutableList<Boolean>) = OnboardingActions(
        skip = { asked += "skip $it" }, check = { asked += "check" }, saveName = {}, savePhoto = {}, finish = {}, web = null, onNotNow = null,
        teammates = TeammatesHost(invite, share = { shared += it }, hold = { holds += it }),
    )

    private val teammatesGate = CloudOnboarding(false, gates = listOf(OnboardingGate("teammates", Scope.Server, Requirement.Optional, Status.Open, kind = Kind.Teammates(false, 1))))

    @Test
    fun anInviteGoesByEmailAndTheStepStaysForMoreUntilContinue() {
        val invited = mutableListOf<String?>()
        val holds = mutableListOf<Boolean>()
        show(teammatesGate, teammates({ email -> invited += email; com.slopus.happy.onboarding.TeamInvite("i1", "https://acme.example/join/x", if (email == "bo@acme.com") "failed" else "sent") }, mutableListOf(), holds))
        rule.onNodeWithText("Invite your team").assertIsDisplayed()
        rule.onNodeWithTag(CloudTags.PRIMARY).assertIsNotEnabled()
        rule.onNodeWithTag(OnboardingStepTags.INVITE_EMAIL).performTextInput("olga@acme")
        rule.onNodeWithTag(CloudTags.PRIMARY).assertIsNotEnabled()
        rule.onNodeWithTag(OnboardingStepTags.INVITE_EMAIL).performTextInput(".com")
        rule.onNodeWithText("Send invite").performClick()
        rule.waitForIdle()
        assertEquals(listOf<String?>("olga@acme.com"), invited)
        rule.onNodeWithText("olga@acme.com").assertIsDisplayed()
        rule.onNodeWithText("Invite sent").assertIsDisplayed()
        // Sent: no skipping now, and the flow waits for Continue.
        assertEquals(0, rule.onAllNodesWithText("Skip for now").fetchSemanticsNodes().size)
        assertEquals(listOf(true), holds)
        assertEquals(listOf("check"), asked)
        rule.onNodeWithTag(OnboardingStepTags.INVITE_EMAIL).performTextInput("bo@acme.com")
        rule.onNodeWithText("Send invite").performClick()
        rule.waitForIdle()
        rule.onNodeWithText("Email not sent").assertIsDisplayed()
        rule.onNodeWithText("Share").assertIsDisplayed()
        rule.onNodeWithText("Continue").performClick()
        assertEquals(listOf(true, true, false), holds)
    }

    @Test
    fun aServerThatCantSendEmailSharesALinkInstead() {
        val shared = mutableListOf<String>()
        val holds = mutableListOf<Boolean>()
        show(teammatesGate, teammates({ email ->
            if (email != null) throw com.slopus.happy.onboarding.TeamInviteRefusal.EmailNotConfigured
            com.slopus.happy.onboarding.TeamInvite("i2", "https://acme.example/join/y")
        }, shared, holds))
        rule.onNodeWithTag(OnboardingStepTags.INVITE_EMAIL).performTextInput("olga@acme.com")
        rule.onNodeWithText("Send invite").performClick()
        rule.waitForIdle()
        rule.onNodeWithText("This server can't send email yet. Share an invite link instead.").assertIsDisplayed()
        // Nothing was sent, so the flow isn't held.
        assertEquals(listOf(true, false), holds)
        rule.onNodeWithText("Share invite link").performClick()
        rule.waitForIdle()
        assertEquals(listOf("https://acme.example/join/y"), shared)
        rule.onNodeWithText("Invite link").assertIsDisplayed()
        rule.onNodeWithText("Continue").assertIsDisplayed()
    }

    private fun notifications(outcome: PushOutcome, opened: MutableList<String>) = OnboardingActions(
        skip = { asked += "skip $it" }, check = { asked += "check" }, saveName = {}, savePhoto = {}, finish = {}, web = null, onNotNow = null,
        notifications = NotificationsHost(turnOn = { outcome }, openSettings = { opened += "settings" }, store = { opened += "store" }),
    )

    private val mobileAppGate = CloudOnboarding(false, gates = listOf(OnboardingGate("mobileApp", Scope.Member, Requirement.Optional, Status.Open, kind = Kind.MobileApp(false, null, null))))

    @Test
    fun notificationsTurnedOnRegisterAndTheServerIsReadAgain() {
        show(mobileAppGate, notifications(PushOutcome.Registered, mutableListOf()))
        rule.onNodeWithTag(CloudTags.PRIMARY).performClick()
        rule.waitForIdle()
        assertEquals(listOf("check"), asked)
    }

    @Test
    fun notificationsTurnedOffOpenTheSettingsAndABuildWithoutPushGooglePlay() {
        val opened = mutableListOf<String>()
        show(mobileAppGate, notifications(PushOutcome.Denied, opened))
        rule.onNodeWithTag(CloudTags.PRIMARY).performClick()
        rule.waitForIdle()
        rule.onNodeWithText("Notifications are off for Happy. Turn them on in Settings, then come back.").assertIsDisplayed()
        rule.onNodeWithText("Open settings").performClick()
        assertEquals(listOf("settings"), opened)
        assertEquals(emptyList<String>(), asked)
    }

    @Test
    fun aBuildWithoutPushOffersGooglePlay() {
        val opened = mutableListOf<String>()
        show(mobileAppGate, notifications(PushOutcome.Unsupported, opened))
        rule.onNodeWithTag(CloudTags.PRIMARY).performClick()
        rule.waitForIdle()
        rule.onNodeWithText("Open Google Play").performClick()
        assertEquals(listOf("store"), opened)
    }
}
