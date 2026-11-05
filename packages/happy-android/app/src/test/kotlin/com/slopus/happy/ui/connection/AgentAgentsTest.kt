package com.slopus.happy.ui.connection

import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.conversation.ModeCatalog
import com.slopus.happy.conversation.ModelPreferences
import com.slopus.happy.conversation.NewSessionStart
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class AgentAgentsTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    private val catalog = ModeCatalog.parse(
        Json.parseToJsonElement(
            """{"config":{
            "defaults":{"providerId":"claude","modelId":"opus","permissionMode":"workspace_write"},
            "models":{
                "opus":{"name":"Opus 5","efforts":["low","medium","high","max"],"defaultEffort":"high"},
                "sol":{"name":"GPT-6 Sol","efforts":["low","high","xhigh"],"defaultEffort":"high"},
                "secret":{"name":"Hidden One","efforts":[]}
            },
            "providers":{
                "claude":{"name":"Claude Max","type":"claude","enabled":true,"models":[{"id":"opus"}]},
                "codex":{"name":"Work","type":"codex","enabled":true,"models":[{"id":"sol"},{"id":"secret","hidden":true}]},
                "codex2":{"name":"Personal","type":"codex","enabled":true,"models":[{"id":"sol"}]}
            }}}""",
        ).jsonObject,
    )

    private fun shot(name: String) {
        val file = File("build/outputs/agents/$name.png")
        file.parentFile?.mkdirs()
        file.outputStream().use { rule.onRoot().captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    /** [text] inside the row tagged [tag]: what the row shows as its value. */
    private fun assertRowShows(tag: String, text: String) =
        rule.onNode(hasText(text) and hasAnyAncestor(hasTestTag(tag)), useUnmergedTree = true).assertExists()

    @Test fun modelsAreListedOncePerModelWithTheirAccountsAndHiddenOnesLeftOut() {
        assertEquals(
            listOf(DefaultModelOption("opus", "Opus 5", "Claude Max"), DefaultModelOption("sol", "GPT-6 Sol", "Work, Personal")),
            defaultModelOptions(catalog),
        )
    }

    @Test fun theRowsShowWhatANewChatWouldStartOnAndSayWhatWasPicked() {
        var preferences by mutableStateOf(ModelPreferences(defaultModelId = "sol", defaultEffort = "xhigh"))
        val picks = mutableListOf<String>()
        rule.setHappyContent {
            AgentAgentsScreen(
                preferences = preferences,
                catalog = AgentModelsCatalog.Ready(catalog),
                onStart = { picks += "start:${it.name}" },
                onModel = { picks += "model:$it" },
                onEffort = { picks += "effort:$it" },
                onAccess = { picks += "access:$it" },
                onBack = {},
            )
        }
        assertRowShows(AgentAgentsTags.START, "Last Session")
        assertRowShows(AgentAgentsTags.MODEL, "GPT-6 Sol")
        assertRowShows(AgentAgentsTags.EFFORT, "xHigh")
        // Unset is auto, whatever the catalog's own default.
        assertRowShows(AgentAgentsTags.ACCESS, "Auto")
        rule.onNodeWithText("The model and effort of the last session you started.").assertExists()
        rule.onNodeWithText("Follows the last session you started, on the account you last picked.").assertExists()
        rule.onNodeWithText("What a new session may do without asking. Saved to your account, so they follow you across devices.").assertExists()
        shot("phone-light-last")
        rule.node(AgentAgentsTags.START).performClick()
        rule.node(AgentAgentsTags.choice(AgentAgentsTags.START, NewSessionStart.LastSession.name)).assertIsSelected()
        rule.node(AgentAgentsTags.choice(AgentAgentsTags.START, NewSessionStart.DefaultModel.name)).performClick()
        rule.node(AgentAgentsTags.MODEL).performClick()
        rule.onNodeWithText("Work, Personal", useUnmergedTree = true).assertExists()
        rule.node(AgentAgentsTags.choice(AgentAgentsTags.MODEL, "opus")).performClick()
        rule.node(AgentAgentsTags.EFFORT).performClick()
        rule.node(AgentAgentsTags.choice(AgentAgentsTags.EFFORT, "low")).performClick()
        rule.node(AgentAgentsTags.ACCESS).performClick()
        rule.node(AgentAgentsTags.choice(AgentAgentsTags.ACCESS, "read_only")).performClick()
        assertEquals(listOf("start:DefaultModel", "model:opus", "effort:low", "access:read_only"), picks)
        // An effort the default model doesn't run shows the model's own; the descriptions follow the mode.
        rule.runOnIdle { preferences = ModelPreferences(defaultModelId = "opus", defaultEffort = "xhigh", access = "full_access", start = NewSessionStart.DefaultModel) }
        assertRowShows(AgentAgentsTags.START, "Default Model")
        assertRowShows(AgentAgentsTags.EFFORT, "High")
        assertRowShows(AgentAgentsTags.ACCESS, "Full access")
        rule.onNodeWithText("The model and effort chosen below.").assertExists()
        rule.onNodeWithText("Runs on the account you last picked in a chat.").assertExists()
        shot("phone-light-default")
    }

    @Test fun theStartChoiceStaysWhileTheModelsCannotBeRead() {
        var catalogState by mutableStateOf<AgentModelsCatalog>(AgentModelsCatalog.Loading)
        rule.setHappyContent {
            AgentAgentsScreen(ModelPreferences(), catalogState, {}, {}, {}, {}, {})
        }
        rule.node(AgentAgentsTags.START).assertExists()
        rule.node(AgentAgentsTags.MODEL).assertDoesNotExist()
        rule.runOnIdle { catalogState = AgentModelsCatalog.Failed }
        rule.onNodeWithText("Couldn’t read the models. Check the connection and open this page again.").assertExists()
        rule.node(AgentAgentsTags.ACCESS).assertExists()
    }

    @Test fun darkUsesTheNormalSettingsCards() {
        rule.setHappyContent(dark = true) {
            AgentAgentsScreen(ModelPreferences(start = NewSessionStart.DefaultModel), AgentModelsCatalog.Ready(catalog), {}, {}, {}, {}, {})
        }
        rule.waitForIdle()
        shot("phone-dark")
    }
}
