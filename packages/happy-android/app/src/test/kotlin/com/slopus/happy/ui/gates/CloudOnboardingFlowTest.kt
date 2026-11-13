package com.slopus.happy.ui.gates

import androidx.compose.ui.test.assertIsDisplayed
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
    fun aPaymentGateSendsThemToTheWebAndSkipsOnlyWhileOptional() {
        show(CloudOnboarding(false, gates = listOf(OnboardingGate("paymentMethod", Scope.Server, Requirement.Optional, Status.Open, kind = Kind.PaymentMethod))))
        rule.onNodeWithText("Finish on the web").assertIsDisplayed()
        rule.onNodeWithText("Adding a payment method is done in Happy on your computer or on the web. Come back here when it's done.").assertIsDisplayed()
        rule.onNodeWithText("Skip for now").performClick()
        rule.waitForIdle()
        assertEquals(listOf("skip paymentMethod"), asked)
    }

    @Test
    fun aRequiredPaymentGateHasNoSkipAndNoWayBack() {
        show(CloudOnboarding(false, gates = listOf(OnboardingGate("payment", Scope.Server, Requirement.Required, Status.Open, kind = Kind.Payment))), actions(notNow = false))
        rule.onNodeWithText("Open on the web").assertIsDisplayed()
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
}
