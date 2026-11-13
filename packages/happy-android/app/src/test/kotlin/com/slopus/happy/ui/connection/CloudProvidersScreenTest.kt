package com.slopus.happy.ui.connection

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.agent.CloudConnection
import com.slopus.happy.agent.CloudCredential
import com.slopus.happy.agent.CloudCapabilities
import com.slopus.happy.agent.CloudDestination
import com.slopus.happy.agent.CloudProviders
import com.slopus.happy.agent.CloudProvidersSource
import com.slopus.happy.agent.CloudSignInRun
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/** The AI providers screens as iOS words them: the list's sections, ChatGPT's device code, a key's check and its refusal. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
class CloudProvidersScreenTest {
    @get:Rule val rule = createComposeRule()

    private fun connection(id: String, name: String, scope: String, source: String, vendors: List<String>, credentials: List<CloudCredential> = emptyList(), enabled: Boolean = true) =
        CloudConnection(id, name, scope, source, vendors, listOf("m"), credentials.size, credentials, enabled)

    @Test
    fun theListGroupsIncludedTeamAndMine() {
        var adds = 0
        val loaded = CloudProvidersSource.State.Loaded(
            listOf(
                connection("operator:openai", "Happy (free)", "team", "operator", listOf("openai")),
                connection("private", "My account", "private", "tenant", listOf("codex", "anthropic"), listOf(CloudCredential("k1", "anthropic", "api_key", "Old key", true, "invalid"))),
            ),
        )
        rule.setHappyContent { CloudProvidersScreen(loaded, canAdd = true, onAdd = { adds++ }, onRetry = {}, onBack = {}) }
        rule.onNodeWithText("INCLUDED").assertIsDisplayed()
        rule.onNodeWithText("Happy (free)").assertIsDisplayed()
        // No team connection yet.
        rule.onNodeWithText("Nothing added yet").assertIsDisplayed()
        rule.onNodeWithText("ChatGPT · Anthropic").assertIsDisplayed()
        rule.onNodeWithText("1 credential").assertIsDisplayed()
        rule.onNodeWithText("Needs attention").assertIsDisplayed()
        rule.onNodeWithTag(CloudProvidersTags.ADD).performClick()
        assertEquals(1, adds)
    }

    @Test
    fun noneToAddWithoutTheRole() {
        rule.setHappyContent { CloudProvidersScreen(CloudProvidersSource.State.Loaded(emptyList()), canAdd = false, onAdd = {}, onRetry = {}, onBack = {}) }
        assertEquals(0, rule.onAllNodesWithTag(CloudProvidersTags.ADD).fetchSemanticsNodes().size)
    }

    @Test
    fun theChooserListsTheFamiliesInIosOrderEachWithItsWays() {
        rule.setHappyContent { CloudAddChooser(CloudCapabilities(apiKeys = true, claudeSetupToken = true, codexSignIn = true), onPick = {}, onDismiss = {}, custom = true) }
        rule.onNodeWithText("Add a provider").assertIsDisplayed()
        val rows = listOf(
            ProviderFamily.Kind.ChatGpt to "Sign in or API key",
            ProviderFamily.Kind.Claude to "Setup token or API key",
            ProviderFamily.Kind.Grok to "xAI API key",
            ProviderFamily.Kind.Custom to "Any endpoint that speaks OpenAI’s API",
        )
        for ((kind, ways) in rows) rule.onNodeWithText(ways).assertIsDisplayed()
        val tops = rows.map { (kind, _) -> rule.onNodeWithTag(CloudProvidersTags.family(kind)).fetchSemanticsNode().boundsInRoot.top }
        assertEquals(tops.sorted(), tops)
    }

    @Test
    fun theChooserOffersOnlyWhatTheServerDoes() {
        // Before `capabilities`: the listed sign-ins and keys, never a setup token; Custom only for those who may define it.
        rule.setHappyContent { CloudAddChooser(CloudCapabilities.listed(setOf("codex")), onPick = {}, onDismiss = {}) }
        rule.onNodeWithText("Sign in or API key").assertIsDisplayed()
        rule.onNodeWithText("API key").assertIsDisplayed()
        rule.onNodeWithText("xAI API key").assertIsDisplayed()
        assertEquals(0, rule.onAllNodesWithTag(CloudProvidersTags.CUSTOM).fetchSemanticsNodes().size)
    }

    @Test
    fun aFamilyWithTwoWaysAsksWhichInTheSheet() {
        var picked: CloudProviderFlow? = null
        rule.setHappyContent { CloudAddChooser(CloudCapabilities(apiKeys = true, claudeSetupToken = true, codexSignIn = true), onPick = { picked = it }, onDismiss = {}) }
        rule.onNodeWithTag(CloudProvidersTags.family(ProviderFamily.Kind.ChatGpt)).performClick()
        rule.onNodeWithText("Sign in with ChatGPT").assertIsDisplayed()
        rule.onNodeWithText("Uses your ChatGPT plan").assertIsDisplayed()
        rule.onNodeWithText("Billed to your OpenAI account").assertIsDisplayed()
        assertEquals(null, picked)
        rule.onNodeWithTag(CloudProvidersTags.FAMILY_BACK).performClick()
        rule.onNodeWithTag(CloudProvidersTags.family(ProviderFamily.Kind.Claude)).performClick()
        rule.onNodeWithText("Use a setup token").assertIsDisplayed()
        rule.onNodeWithText("Uses your Claude plan, from claude setup-token").assertIsDisplayed()
        rule.onNodeWithText("Anthropic API key").performClick()
        rule.waitForIdle()
        assertEquals(CloudProviderFlow.ApiKey(CloudProviders.ANTHROPIC), picked)
    }

    @Test
    fun aFamilyWithOneWayOpensIt() {
        var picked: CloudProviderFlow? = null
        rule.setHappyContent { CloudAddChooser(CloudCapabilities(apiKeys = false, claudeSetupToken = true, codexSignIn = false), onPick = { picked = it }, onDismiss = {}) }
        rule.onNodeWithText("Setup token").assertIsDisplayed()
        assertEquals(0, rule.onAllNodesWithTag(CloudProvidersTags.family(ProviderFamily.Kind.ChatGpt)).fetchSemanticsNodes().size)
        assertEquals(0, rule.onAllNodesWithTag(CloudProvidersTags.family(ProviderFamily.Kind.Grok)).fetchSemanticsNodes().size)
        rule.onNodeWithTag(CloudProvidersTags.family(ProviderFamily.Kind.Claude)).performClick()
        rule.waitForIdle()
        assertEquals(CloudProviderFlow.Claude, picked)
    }

    @Test
    fun chatGptsCodeShowsWithCopyAndOpen() {
        var opened: String? = null
        rule.setHappyContent {
            CloudDeviceScreen(
                state = CloudSignInRun.State.Waiting("https://auth.openai.com/codex/device", "ABCD-1234", acceptsCode = false),
                allowed = listOf(CloudDestination.Private, CloudDestination.Team),
                destination = CloudDestination.Private,
                onDestination = {},
                onOpen = { opened = it },
                onRetry = {},
                onBack = {},
            )
        }
        rule.onNodeWithText("Enter this code at OpenAI").assertIsDisplayed()
        rule.onNodeWithTag(CloudProvidersTags.CODE).assertTextEquals("ABCD-1234")
        rule.onNodeWithText("Waiting for you to finish…").assertIsDisplayed()
        rule.onNodeWithText("SAVE TO").assertIsDisplayed()
        rule.onNodeWithTag(CloudProvidersTags.OPEN).performClick()
        assertEquals("https://auth.openai.com/codex/device", opened)
    }

    @Test
    fun anExpiredCodeSaysSoAndTriesAgain() {
        var retries = 0
        rule.setHappyContent {
            CloudDeviceScreen(
                state = CloudSignInRun.State.Failed("expired", "The sign-in code expired. Start again."),
                allowed = listOf(CloudDestination.Private),
                destination = CloudDestination.Private,
                onDestination = {},
                onOpen = {},
                onRetry = { retries++ },
                onBack = {},
            )
        }
        rule.onNodeWithText("Code expired").assertIsDisplayed()
        rule.onNodeWithText("The sign-in code expired. Start again.").assertIsDisplayed()
        // Only one place it may go: no picker.
        assertEquals(0, rule.onAllNodesWithText("SAVE TO").fetchSemanticsNodes().size)
        rule.onNodeWithText("Try again").performClick()
        assertEquals(1, retries)
    }

    @Test
    fun aKeyIsAddedOnlyOnceTypedAndARefusalShowsTheServersWords() {
        val sent = mutableListOf<String>()
        var phase: SecretPhase = SecretPhase.Editing
        rule.setHappyContent {
            CloudSecretScreen(
                title = "Add API key", field = "API key", hint = null, done = "API key added",
                allowed = listOf(CloudDestination.Private), destination = CloudDestination.Private, onDestination = {},
                vendors = listOf(CloudProviders.OPENAI, CloudProviders.ANTHROPIC), vendor = CloudProviders.OPENAI, onVendor = {},
                phase = phase, onSubmit = { sent += it }, onRetry = {}, onBack = {},
            )
        }
        rule.onNodeWithText("OpenAI").assertIsDisplayed()
        rule.onNodeWithText("Anthropic").assertIsDisplayed()
        rule.onNodeWithTag(CloudProvidersTags.SUBMIT).assertIsNotEnabled()
        rule.onNodeWithTag(CloudProvidersTags.FIELD).performTextInput("sk-test")
        rule.onNodeWithTag(CloudProvidersTags.SUBMIT).performClick()
        assertEquals(listOf("sk-test"), sent)
    }

    @Test
    fun aRefusedKeySaysWhy() {
        rule.setHappyContent {
            CloudSecretScreen(
                title = "Add API key", field = "API key", hint = null, done = "API key added",
                allowed = listOf(CloudDestination.Private), destination = CloudDestination.Private, onDestination = {},
                vendors = listOf(CloudProviders.OPENAI), vendor = CloudProviders.OPENAI, onVendor = {},
                phase = SecretPhase.Failed("The vendor rejected the credential."), onSubmit = {}, onRetry = {}, onBack = {},
            )
        }
        rule.onNodeWithText("Couldn't add the key").assertIsDisplayed()
        rule.onNodeWithText("The vendor rejected the credential.").assertIsDisplayed()
    }

    @Test
    fun theOwnEndpointIsOfferedOnlyToThoseWhoMayDefineIt() {
        var picked: CloudProviderFlow? = null
        var custom by androidx.compose.runtime.mutableStateOf(false)
        rule.setHappyContent { CloudAddChooser(CloudCapabilities(apiKeys = true, claudeSetupToken = false, codexSignIn = false), onPick = { picked = it }, onDismiss = {}, custom = custom) }
        assertEquals(0, rule.onAllNodesWithTag(CloudProvidersTags.CUSTOM).fetchSemanticsNodes().size)
        custom = true
        rule.onNodeWithText("Any endpoint that speaks OpenAI\u2019s API").performClick()
        rule.waitForIdle()
        assertEquals(CloudProviderFlow.Custom, picked)
    }

    @Test
    fun aKeyMayBeGroks() {
        rule.setHappyContent {
            CloudSecretScreen(
                title = "Add API key", field = "API key", hint = null, done = "API key added",
                allowed = listOf(CloudDestination.Private), destination = CloudDestination.Private, onDestination = {},
                vendors = listOf(CloudProviders.OPENAI, CloudProviders.ANTHROPIC, CloudProviders.GROK), vendor = CloudProviders.GROK, onVendor = {},
                phase = SecretPhase.Editing, onSubmit = {}, onRetry = {}, onBack = {},
            )
        }
        rule.onNodeWithText("Grok").assertIsDisplayed()
    }

    @Test
    fun anEndpointGetsItsIdFromItsNameAndIsCheckedBeforeItGoes() {
        val sent = mutableListOf<com.slopus.happy.agent.CustomProvider>()
        rule.setHappyContent { CloudCustomScreen(SecretPhase.Editing, onSubmit = { sent += it }, onRetry = {}, onBack = {}) }
        fun field(problem: com.slopus.happy.agent.CustomProvider.Problem) = rule.onNodeWithTag(CloudProvidersTags.customField(problem))
        rule.onNodeWithTag(CloudProvidersTags.SUBMIT).assertIsNotEnabled()
        field(com.slopus.happy.agent.CustomProvider.Problem.Name).performTextInput("Acme vLLM")
        field(com.slopus.happy.agent.CustomProvider.Problem.Id).assertTextEquals("acme-vllm")
        field(com.slopus.happy.agent.CustomProvider.Problem.BaseUrl).performTextInput("http://llm.example.com/v1")
        field(com.slopus.happy.agent.CustomProvider.Problem.Models).performTextInput("llama-4-70b")
        field(com.slopus.happy.agent.CustomProvider.Problem.ApiKey).performTextInput("sk-own")
        rule.onNodeWithTag(CloudProvidersTags.SUBMIT).performClick()
        rule.onNodeWithTag(CloudProvidersTags.customError(com.slopus.happy.agent.CustomProvider.Problem.BaseUrl)).assertIsDisplayed()
        rule.onNodeWithText("Enter an address that starts with https://.").assertIsDisplayed()
        assertEquals(emptyList<Any>(), sent)
        field(com.slopus.happy.agent.CustomProvider.Problem.BaseUrl).performTextReplacement("https://llm.example.com/v1")
        rule.onNodeWithTag(CloudProvidersTags.SUBMIT).performClick()
        assertEquals(listOf(com.slopus.happy.agent.CustomProvider("Acme vLLM", "acme-vllm", "https://llm.example.com/v1", "llama-4-70b", "sk-own")), sent)
    }

    @Test
    fun aRefusedEndpointSaysWhyAndComesBackForAnotherTry() {
        var retries = 0
        rule.setHappyContent { CloudCustomScreen(SecretPhase.Failed("A provider with this ID already exists. Choose another ID."), onSubmit = {}, onRetry = { retries++ }, onBack = {}) }
        rule.onNodeWithText("Couldn't add the endpoint").assertIsDisplayed()
        rule.onNodeWithText("A provider with this ID already exists. Choose another ID.").assertIsDisplayed()
        rule.onNodeWithText("Try again").performClick()
        assertEquals(1, retries)
    }

    @Test
    fun aTeamsOwnEndpointIsNamedByItsProtocolNotItsId() {
        org.junit.Assert.assertEquals("OpenAI-compatible", vendorName("openai_compatible"))
        org.junit.Assert.assertEquals("Grok", vendorName(com.slopus.happy.agent.CloudProviders.GROK))
    }
}
