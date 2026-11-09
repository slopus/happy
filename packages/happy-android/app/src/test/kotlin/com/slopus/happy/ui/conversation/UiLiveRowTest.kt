package com.slopus.happy.ui.conversation

import android.graphics.Bitmap
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.agent.GithubLink
import com.slopus.happy.agent.ProviderCli
import com.slopus.happy.agent.ProviderCliSource
import com.slopus.happy.agent.TeamRole
import com.slopus.happy.conversation.AgentInfo
import com.slopus.happy.conversation.ConversationRow
import com.slopus.happy.conversation.ConversationRowBuilder
import com.slopus.happy.conversation.ConversationState
import com.slopus.happy.conversation.Message
import com.slopus.happy.conversation.ModeCatalog
import com.slopus.happy.conversation.ModelChoice
import com.slopus.happy.conversation.Mode
import com.slopus.happy.conversation.UiWork
import com.slopus.happy.conversation.ui.UiAction
import com.slopus.happy.conversation.ui.UiOffer
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

/** Live chat UI components ([UiLiveRow]), drawn from the server's state and acting through silent actions. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class UiLiveRowTest {
    @get:Rule
    val rule = createComposeRule()

    private val agent = AgentInfo("a1", "w1", null, "Onboarding", "idle", null, null, 1, 2, 0, 0)
    private val sent = ArrayList<Pair<UiOffer, UiAction>>()
    /** What the next action answers with. */
    private var answer: Deferred<JsonObject?> = CompletableDeferred(null)
    private val cli = MutableStateFlow<ProviderCliSource.State>(ProviderCliSource.State.Reading)

    private fun shot(name: String) {
        val dir = File("build/conversation-screens").apply { mkdirs() }
        File(dir, "$name.png").outputStream().use { rule.onRoot().captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private fun offer(vararg components: String): List<ConversationRow> {
        val message = Message.parse(
            Json.parseToJsonElement(
                """{"id":"m1","role":"agent","createdAt":1,"metadata":{},"content":[{"type":"ui","ui":{"id":"u1","components":[${components.joinToString(",")}]}}]}""",
            ),
        )!!
        return ConversationRowBuilder.build(message, "a1", null, streaming = false)
    }

    private val link = MutableStateFlow<GithubLink>(GithubLink.None)

    private val live = UiLive(
        providerCli = { cli },
        team = true,
        roles = { listOf(TeamRole("owner", "Owner", true), TeamRole("admin", "Admin", true), TeamRole("member", "Member", true)) },
        github = { link },
    )

    private val catalog = ModeCatalog(
        listOf(
            ModelChoice("claude", "Claude", "claude", "anthropic/opus-5", "Opus 5", listOf("low", "medium", "high"), "high", emptyList()),
            ModelChoice("codex", "Codex", "codex", "openai/gpt-5.6", "GPT-5.6", listOf("medium", "high"), "medium", emptyList()),
        ),
        Mode("claude", "anthropic/opus-5", "high", null, "auto"),
    )

    private var shown by mutableStateOf(true)

    private fun screen(rows: List<ConversationRow>, allows: (String) -> Boolean = { true }) {
        rule.setHappyContent {
            if (shown) {
                ConversationScreen(
                    ConversationState(created = true, loaded = true, rows = rows.asReversed(), agent = agent, catalog = catalog),
                    ConversationScreenActions(onUiAction = { offer, _, action -> sent += offer to action; answer }),
                    roleAllows = allows,
                    uiLive = live,
                )
            }
        }
        rule.waitForIdle()
    }

    private fun parse(text: String) = ProviderCli.parse(Json.parseToJsonElement(text).jsonObject)!!

    private fun claude(signIn: String = "signed_out", operation: String = "null") = parse(
        """{"id":"claude","name":"Claude Code","installation":{"status":"installed","version":"2.1.312"},
        "installer":{"command":"curl -fsSL https://claude.ai/install.sh | bash","sourceHost":"claude.ai"},
        "signIn":{"status":"$signIn","account":${if (signIn == "signed_in") """{"email":"ada@example.com","plan":"Max"}""" else "null"}},
        "operation":$operation,"version":"01a"}""",
    )

    private val signIn = """{"id":"claude","type":"provider_sign_in","fallback":"Sign in to Claude in Happy on your computer","props":{"provider":"claude"}}"""
    private val model = """{"id":"model","type":"default_model","fallback":"Pick a default model in Settings","props":{}}"""
    private val invite = """{"id":"inv","type":"invite","fallback":"Invite a teammate in Settings","props":{}}"""
    private val github = """{"id":"gh","type":"github_connect","fallback":"Connect GitHub in Settings","props":{}}"""
    private val join = """{"id":"join","type":"compute_join","fallback":"Add a computer in Settings","props":{"pool":"builders"}}"""

    @Test fun `a signed-out AI signs in, or takes a setup token masked and gone once sent`() {
        cli.value = ProviderCliSource.State.Read(claude())
        screen(offer(signIn))
        rule.onNodeWithText("Installed (2.1.312). Not signed in yet.").assertExists()
        rule.onNodeWithText("Sign in").performClick()
        rule.node(UiLiveTags.SECRET_FIELD).performTextInput("sk-ant-oat01-secret")
        // Drawn masked.
        rule.node(UiLiveTags.SECRET_FIELD).assertTextEquals("•".repeat(19))
        shot("ui-live-sign-in")
        rule.onNodeWithText("Send").performClick()
        assertEquals(
            listOf(
                UiAction("provider_sign_in.sign_in", JsonObject(emptyMap())),
                UiAction("provider_sign_in.submit_token", buildJsonObject { put("token", "sk-ant-oat01-secret") }),
            ),
            sent.map { it.second },
        )
        assertEquals(UiOffer("m1", "u1", "claude"), sent.first().first)
        rule.node(UiLiveTags.SECRET_FIELD).assertTextEquals("")
    }

    @Test fun `a sign-in under way offers its page, a code and Cancel`() {
        cli.value = ProviderCliSource.State.Read(
            claude(
                operation = """{"kind":"sign_in","status":"waiting","message":"Waiting for you to finish signing in to Claude in your browser.",
                "authorization":{"method":"browser","url":"https://claude.com/cai/oauth/authorize","acceptsCode":true}}""",
            ),
        )
        screen(offer(signIn))
        rule.onNodeWithText("Waiting for you to finish signing in to Claude in your browser.").assertExists()
        rule.onNodeWithText("Open sign-in page").assertExists()
        rule.node(UiLiveTags.SECRET_FIELD).assertExists()
        shot("ui-live-sign-in-waiting")
        rule.onNodeWithText("Cancel").performClick()
        assertEquals(listOf("provider_sign_in.cancel"), sent.map { it.second.type })
    }

    @Test fun `a signed-in AI is used as it is, and one the server doesn't run points to Settings`() {
        cli.value = ProviderCliSource.State.Read(claude(signIn = "signed_in"))
        screen(offer(signIn))
        rule.onNodeWithText("Signed in as ada@example.com · Max").assertExists()
        rule.onNodeWithText("Use Claude Code").performClick()
        assertEquals(listOf("provider_sign_in.sign_in"), sent.map { it.second.type })
        cli.value = ProviderCliSource.State.Unsupported
        rule.onNodeWithText("This server's AIs are set up in Settings.").assertExists()
    }

    @Test fun `the default model changes in place, and a role without config manage only sees it`() {
        screen(offer(model))
        rule.onNodeWithText("Opus 5").assertExists()
        rule.onNodeWithText("New chats start here. Chats you already have keep their own.").assertExists()
        shot("ui-live-default-model")
        rule.onNodeWithText("Opus 5").performClick()
        rule.onNodeWithText("GPT-5.6").performClick()
        assertEquals(
            listOf(UiAction("default_model.set", buildJsonObject { put("providerId", "codex"); put("modelId", "openai/gpt-5.6"); put("effort", "high") })),
            sent.map { it.second },
        )
    }

    @Test fun `without config manage the model is shown, not changed`() {
        screen(offer(model), allows = { it != "config.manage" })
        rule.onNodeWithText("Your role can't change this here.").assertExists()
        rule.onNodeWithText("Opus 5").performClick()
        rule.onNodeWithText("GPT-5.6").assertDoesNotExist()
        assertTrue(sent.isEmpty())
    }

    @Test fun `an invite code is shown in the widget alone, and gone when the widget goes`() {
        answer = CompletableDeferred(buildJsonObject { put("inviteId", "i1"); put("code", "INV-7F3K"); put("expiresAt", 9); put("serverName", "Acme") })
        screen(offer(invite))
        rule.onNodeWithText("Anyone with the code joins as Member, until it expires.").assertExists()
        rule.onNodeWithText("Create invite code").performClick()
        rule.waitForIdle()
        assertEquals(listOf(UiAction("invite.create", buildJsonObject { put("role", "member") })), sent.map { it.second })
        rule.onNodeWithText("INV-7F3K").assertExists()
        rule.onNodeWithText("Joins Acme as Member · Shown only here").assertExists()
        shot("ui-live-invite")
        shown = false
        rule.waitForIdle()
        shown = true
        rule.waitForIdle()
        rule.onNodeWithText("INV-7F3K").assertDoesNotExist()
        rule.onNodeWithText("Create invite code").assertExists()
    }

    @Test fun `a refused action says why on its widget, and one under way busies it`() {
        val rows = offer(github, join).map { row ->
            if (row is ConversationRow.Ui && row.component.type == "compute_join") row.copy(work = UiWork(refused = true, reason = "Pool builders is full."))
            else if (row is ConversationRow.Ui) row.copy(work = UiWork(pending = true))
            else row
        }
        screen(rows)
        rule.onNodeWithText("Pool builders is full.").assertExists()
        shot("ui-live-github-compute")
        rule.onNodeWithText("Link GitHub").performClick()
        assertTrue("busy takes nothing", sent.none { it.second.type == "github_connect.device_start" })
        rule.onNodeWithText("Make join command").performClick()
        assertEquals(listOf("compute_join.create"), sent.map { it.second.type })
    }

    @Test fun `a GitHub device code goes once the server has the credential`() {
        answer = CompletableDeferred(buildJsonObject { put("userCode", "WDJB-MJHT"); put("verificationUri", "https://github.com/login/device"); put("expiresAt", 9) })
        screen(offer(github))
        rule.onNodeWithText("Link GitHub").performClick()
        rule.waitForIdle()
        rule.onNodeWithText("WDJB-MJHT").assertExists()
        rule.onNodeWithText("Open GitHub").assertExists()
        shot("ui-live-github-code")
        link.value = GithubLink.Linked("ada")
        rule.waitForIdle()
        rule.onNodeWithText("WDJB-MJHT").assertDoesNotExist()
        rule.onNodeWithText("Connected as ada.").assertExists()
        rule.onNodeWithText("Link GitHub").assertDoesNotExist()
        shot("ui-live-github-connected")
    }

    @Test fun `team components are fallback lines off a team server`() {
        rule.setHappyContent {
            ConversationScreen(
                ConversationState(created = true, loaded = true, rows = offer(invite, join).asReversed(), agent = agent),
                ConversationScreenActions(),
                uiLive = UiLive(null, team = false, roles = { emptyList() }),
            )
        }
        rule.onNodeWithText("Invite a teammate in Settings").assertExists()
        rule.onNodeWithText("Add a computer in Settings").assertExists()
    }
}
