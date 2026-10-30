package com.slopus.happy.ui.conversation

import android.graphics.Bitmap
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.height
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.unit.dp
import androidx.compose.ui.test.assertIsNotDisplayed
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.hasImeAction
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performImeAction
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextClearance
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.text.input.ImeAction
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.conversation.Activity
import com.slopus.happy.conversation.AgentInfo
import com.slopus.happy.conversation.ConversationApiException
import com.slopus.happy.conversation.ConversationState
import com.slopus.happy.conversation.Question
import com.slopus.happy.conversation.SecretSummary
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.assertActionsLabelled
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import com.slopus.happy.ui.spoken
import kotlinx.coroutines.CompletableDeferred
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

/**
 * An agent asking for a credential (API.md "Secret requests"): the form the
 * request describes, the secret made from it, and the id alone going back as
 * the answer. Every value here is made up for the test; none of it reaches a
 * real account, and the computer it talks to is this recorder.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class SecretRequestTest {
    @get:Rule
    val rule = createComposeRule()

    private val request = Question.SecretRequest(
        suggestedId = "deploy-api",
        description = "Staging deployment API credentials",
        variables = listOf(
            Question.SecretVariable("DEPLOY_API_TOKEN", "Token with the deploy scope"),
            Question.SecretVariable("DEPLOY_ORGANIZATION", null),
        ),
    )

    private fun question(request: Question.SecretRequest? = this.request) = Question(
        id = "q1",
        status = "pending",
        context = "The deploy step needs the staging API token.",
        prompts = listOf(Question.Prompt("secret", "Secret", "Staging token", false, emptyList(), request)),
        permissionFrom = null,
        isPermission = false,
    )

    private class Recorder {
        val created = ArrayList<Triple<String?, String?, Map<String, String>>>()
        val answered = ArrayList<Map<String, List<String>>>()
        var catalog = listOf(
            SecretSummary("other-api", "Something else", listOf("OTHER_TOKEN"), true),
            SecretSummary("deploy-api-old", "Last year's deploy keys", listOf("DEPLOY_API_TOKEN", "DEPLOY_ORGANIZATION"), true),
        )
        var conflict = false
        /** The answer that can't be delivered, as if the phone had gone offline. */
        var answerFails = false
    }

    private fun show(recorder: Recorder, request: Question.SecretRequest? = this.request) {
        rule.setHappyContent {
            ConversationQuestionCard(
                question = question(request),
                onAnswer = {
                    if (recorder.answerFails) throw ConversationApiException(0, null, "offline")
                    recorder.answered += it
                },
                secrets = SecretRequestActions(
                    secrets = { recorder.catalog },
                    create = { id, description, values ->
                        if (recorder.conflict) throw ConversationApiException(409, "conflict", "secret already exists")
                        recorder.created += Triple(id, description, values)
                        "made-$id"
                    },
                ),
            )
        }
    }

    // The question card caps itself at 360dp and the form's fields scroll inside,
    // so a field this far down is reached the way a person does: by scrolling to it.
    private fun at(tag: String): SemanticsNodeInteraction = rule.node(tag).performScrollTo()

    // Cancel, Save and what went wrong stay below the fields: on screen with no scrolling.
    private fun pinned(tag: String): SemanticsNodeInteraction = rule.node(tag).assertIsDisplayed()

    private fun fields() = rule.onAllNodesWithTag(SecretRequestTags.VALUE, useUnmergedTree = true)

    private fun fill(token: String = "token-synthetic", organization: String = "acme") {
        fields()[0].performScrollTo().performTextInput(token)
        fields()[1].performScrollTo().performTextInput(organization)
    }

    private fun shot(name: String) {
        val dir = File("build/conversation-screens").apply { mkdirs() }
        File(dir, "$name.png").outputStream().use { rule.onRoot().captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    @Test fun `the form is filled in from the request, and nothing reads back what was typed`() {
        val recorder = Recorder()
        show(recorder)
        rule.node(SecretRequestTags.FORM).assertIsDisplayed()
        rule.onNodeWithText("deploy-api").assertIsDisplayed()
        rule.onNodeWithText("DEPLOY_API_TOKEN").assertIsDisplayed()
        rule.onNodeWithText("Token with the deploy scope").assertIsDisplayed()
        fields()[0].performScrollTo().performTextInput("token-synthetic")
        // What a screen reader would say for the field: its name, and dots.
        val said = fields()[0].fetchSemanticsNode().spoken
        assertTrue(said, said.contains("DEPLOY_API_TOKEN"))
        assertFalse(said, said.contains("token-synthetic"))
        // Nothing has been sent, either.
        assertTrue(recorder.created.isEmpty())
        assertTrue(recorder.answered.isEmpty())
        shot("secret-form")
    }

    @Test fun `saving makes the secret and answers with its id alone`() {
        val recorder = Recorder()
        show(recorder)
        fill()
        pinned(SecretRequestTags.SUBMIT).performClick()
        rule.waitForIdle()
        val (id, description, values) = recorder.created.single()
        assertEquals("deploy-api", id)
        assertEquals("Staging deployment API credentials", description)
        assertEquals(mapOf("DEPLOY_API_TOKEN" to "token-synthetic", "DEPLOY_ORGANIZATION" to "acme"), values)
        // The answer carries the id the daemon returned, under the prompt that asked.
        assertEquals(listOf(mapOf("secret" to listOf("made-deploy-api"))), recorder.answered)
    }

    @Test fun `a name already taken says so and keeps what was typed`() {
        val recorder = Recorder()
        recorder.conflict = true
        show(recorder)
        fill()
        pinned(SecretRequestTags.SUBMIT).performClick()
        rule.waitForIdle()
        pinned(SecretRequestTags.PROBLEM)
        rule.onNodeWithText("That name is taken. Choose another.").assertIsDisplayed()
        assertTrue(recorder.answered.isEmpty())
        // The message never carries what the daemon said, in case a value was in it.
        rule.onNodeWithText("already exists", substring = true).assertDoesNotExist()
        shot("secret-conflict")
    }

    @Test fun `a taken name can be tried again under another`() {
        val recorder = Recorder()
        recorder.conflict = true
        show(recorder)
        fill()
        pinned(SecretRequestTags.SUBMIT).performClick()
        rule.waitForIdle()
        pinned(SecretRequestTags.PROBLEM)
        recorder.conflict = false
        at(SecretRequestTags.NAME).performTextClearance()
        at(SecretRequestTags.NAME).performTextInput("deploy-api-staging")
        rule.node(SecretRequestTags.PROBLEM).assertDoesNotExist()
        pinned(SecretRequestTags.SUBMIT).performClick()
        rule.waitForIdle()
        // One secret, under the new name, out of the values typed before.
        val (id, _, values) = recorder.created.single()
        assertEquals("deploy-api-staging", id)
        assertEquals(mapOf("DEPLOY_API_TOKEN" to "token-synthetic", "DEPLOY_ORGANIZATION" to "acme"), values)
        assertEquals(listOf(mapOf("secret" to listOf("made-deploy-api-staging"))), recorder.answered)
    }

    @Test fun `an answer that cannot be delivered is tried again with the id already made`() {
        val recorder = Recorder()
        recorder.answerFails = true
        show(recorder)
        fill()
        pinned(SecretRequestTags.SUBMIT).performClick()
        rule.waitForIdle()
        assertEquals(1, recorder.created.size)
        pinned(SecretRequestTags.PROBLEM)
        rule.onNodeWithText("The secret was saved, but the answer didn't get through. Try again.").assertIsDisplayed()
        // The secret exists now, so the form says so and asks for nothing again.
        at(SecretRequestTags.KEPT).assertIsDisplayed()
        rule.onNodeWithText("Saved as made-deploy-api. Answering again needs no retyping.").assertIsDisplayed()
        assertEquals(0, fields().fetchSemanticsNodes().size)
        shot("secret-answer-failed")
        // Trying again answers with the id already returned: no second secret.
        recorder.answerFails = false
        pinned(SecretRequestTags.SUBMIT).performClick()
        rule.waitForIdle()
        assertEquals(1, recorder.created.size)
        assertEquals(listOf(mapOf("secret" to listOf("made-deploy-api"))), recorder.answered)
    }

    @Test fun `cancelling forgets what was typed and sends nothing`() {
        val recorder = Recorder()
        show(recorder)
        fill()
        pinned(SecretRequestTags.CANCEL).performClick()
        rule.waitForIdle()
        // Both fields are empty again, so there is nothing left to save.
        fields().fetchSemanticsNodes().forEach { assertFalse(it.spoken, it.spoken.contains("•")) }
        pinned(SecretRequestTags.SUBMIT).performClick()
        rule.waitForIdle()
        assertTrue(recorder.created.isEmpty())
        assertTrue(recorder.answered.isEmpty())
    }

    @Test fun `a secret already held, carrying every variable, answers without making one`() {
        val recorder = Recorder()
        show(recorder)
        at(SecretRequestTags.EXISTING).performClick()
        rule.waitForIdle()
        // Only the one that holds every variable the agent asked for.
        rule.onNodeWithText("deploy-api-old", substring = true).performScrollTo().assertIsDisplayed()
        rule.onNodeWithText("other-api", substring = true).assertDoesNotExist()
        rule.onAllNodesWithTag(SecretRequestTags.PICK, useUnmergedTree = true).onFirst().performScrollTo().performClick()
        rule.waitForIdle()
        assertTrue(recorder.created.isEmpty())
        assertEquals(listOf(mapOf("secret" to listOf("deploy-api-old"))), recorder.answered)
    }

    @Test fun `a secret the agents may not read is not offered`() {
        val recorder = Recorder()
        recorder.catalog = listOf(
            SecretSummary("deploy-api-old", "Last year's deploy keys", listOf("DEPLOY_API_TOKEN", "DEPLOY_ORGANIZATION"), false),
        )
        show(recorder)
        at(SecretRequestTags.EXISTING).performClick()
        rule.waitForIdle()
        rule.onAllNodesWithTag(SecretRequestTags.PICK, useUnmergedTree = true).assertCountEquals(0)
        rule.onNodeWithText("deploy-api-old", substring = true).assertDoesNotExist()
    }

    @Test fun `a request that names nothing says so instead of showing a form`() {
        val recorder = Recorder()
        show(recorder, Question.SecretRequest("deploy-api", "Staging deployment API credentials", emptyList()))
        at(SecretRequestTags.MALFORMED).assertIsDisplayed()
        rule.node(SecretRequestTags.FORM).assertDoesNotExist()
        // Above all, no picker: an empty request is covered by every secret there is.
        rule.node(SecretRequestTags.EXISTING).assertDoesNotExist()
        shot("secret-malformed")
    }

    @Test fun `a request naming the same variable twice says so instead of showing a form`() {
        val recorder = Recorder()
        show(
            recorder,
            Question.SecretRequest(
                "deploy-api", null,
                listOf(Question.SecretVariable("TOKEN", null), Question.SecretVariable("token", null)),
            ),
        )
        at(SecretRequestTags.MALFORMED).assertIsDisplayed()
        rule.node(SecretRequestTags.FORM).assertDoesNotExist()
    }

    @Test fun `every value field says which variable it is`() {
        val recorder = Recorder()
        show(recorder)
        rule.onNodeWithText("DEPLOY_ORGANIZATION").assertIsDisplayed()
        rule.onNodeWithContentDescription("DEPLOY_API_TOKEN", useUnmergedTree = true).assertExists()
        rule.onNodeWithContentDescription("DEPLOY_ORGANIZATION", useUnmergedTree = true).assertExists()
        rule.assertActionsLabelled()
    }

    @Test fun `the keyboard carries on to the next variable`() {
        val recorder = Recorder()
        show(recorder)
        fields().onFirst().assert(hasImeAction(ImeAction.Next))
    }

    @Test fun `only the last field's key is Done, and Done keeps the value and sends nothing`() {
        val recorder = Recorder()
        show(recorder)
        fields()[0].assert(hasImeAction(ImeAction.Next))
        fields()[1].assert(hasImeAction(ImeAction.Done))
        fill()
        fields()[1].performScrollTo().performImeAction()
        rule.waitForIdle()
        // Still there, still dots, and nothing went anywhere.
        val said = fields()[1].fetchSemanticsNode().spoken
        assertTrue(said, said.contains("••••"))
        assertFalse(said, said.contains("acme"))
        assertTrue(recorder.created.isEmpty())
        assertTrue(recorder.answered.isEmpty())
        // Save is right there for the person to choose.
        pinned(SecretRequestTags.SUBMIT).assertIsEnabled().performClick()
        rule.waitForIdle()
        assertEquals(mapOf("DEPLOY_API_TOKEN" to "token-synthetic", "DEPLOY_ORGANIZATION" to "acme"), recorder.created.single().third)
    }

    private val agent = AgentInfo("a1", "w1", null, "Deploy staging", "idle", null, null, 1_755_300_000_000, 1_755_400_000_000, 0, 2)

    /** The whole chat screen, so the card gets the room it really has over the composer. */
    private fun showScreen(recorder: Recorder) {
        rule.setHappyContent {
            ConversationScreen(
                ConversationState(created = true, loaded = true, agent = agent, question = question(), activity = Activity.AwaitingAnswer),
                null,
                ConversationScreenActions(
                    secrets = SecretRequestActions(secrets = { recorder.catalog }, create = { id, _, _ -> "made-$id" }),
                ),
            )
        }
    }

    /** Save on screen at rest, inside the card, while the fields above it are cut by the cap. */
    private fun assertButtonsBelowCutFields(name: String) {
        val card = rule.node(ConversationQuestionTags.CARD).bounds
        val save = pinned(SecretRequestTags.SUBMIT).bounds
        pinned(SecretRequestTags.CANCEL)
        assertTrue("save $save inside card $card", save.top >= card.top && save.bottom <= card.bottom)
        // The card leaves the bar and the composer whole on screen.
        val screen = rule.onRoot().bounds
        val bar = rule.node(ConversationScreenTags.BAR).assertIsDisplayed().bounds
        val composer = rule.node(ConversationComposerTags.COMPOSER).assertIsDisplayed().bounds
        assertTrue("bar $bar on screen $screen", bar.top >= screen.top && bar.bottom <= card.top)
        assertTrue("composer $composer below card $card on screen $screen", composer.top >= card.bottom && composer.bottom <= screen.bottom)
        // The form is taller than the card: the last of it is out of view until scrolled to.
        rule.node(SecretRequestTags.EXISTING).assertIsNotDisplayed()
        shot("$name-at-rest")
        at(SecretRequestTags.EXISTING).assertIsDisplayed()
        pinned(SecretRequestTags.SUBMIT)
        shot("$name-scrolled")
    }

    @Test fun `with no room over the keyboard the field keeps it, and the buttons come back with the room`() {
        val recorder = Recorder()
        // What a short screen leaves the card with the keyboard up, then down.
        var room by mutableStateOf(60.dp)
        rule.setHappyContent {
            Box(Modifier.height(room)) {
                ConversationQuestionCard(
                    question = question(),
                    onAnswer = { recorder.answered += it },
                    secrets = SecretRequestActions(secrets = { recorder.catalog }, create = { id, _, _ -> "made-$id" }),
                )
            }
        }
        fields()[0].performScrollTo().performClick().performTextInput("token-synthetic")
        fields()[0].assertIsDisplayed().assertIsFocused()
        rule.node(SecretRequestTags.SUBMIT).assertIsNotDisplayed()
        room = 360.dp
        rule.waitForIdle()
        pinned(SecretRequestTags.SUBMIT)
        // The same field, never recomposed elsewhere: still focused, still holding what was typed.
        fields()[0].assertIsFocused()
        assertTrue(fields()[0].fetchSemanticsNode().spoken.contains("••••"))
        assertTrue(recorder.created.isEmpty())
    }

    @Config(qualifiers = "w411dp-h731dp-xxhdpi")
    @Test fun `on a 731dp phone Save is on screen without scrolling`() {
        showScreen(Recorder())
        assertButtonsBelowCutFields("secret-buttons-731")
    }

    @Config(qualifiers = "w731dp-h411dp-xxhdpi")
    @Test fun `on a 411dp-tall screen Save is on screen without scrolling`() {
        showScreen(Recorder())
        assertButtonsBelowCutFields("secret-buttons-411")
    }

    @Test fun `a half-filled form sends nothing`() {
        val recorder = Recorder()
        show(recorder)
        fields()[0].performScrollTo().performTextInput("token-synthetic")
        pinned(SecretRequestTags.SUBMIT).performClick()
        rule.waitForIdle()
        assertTrue(recorder.created.isEmpty())
        assertTrue(recorder.answered.isEmpty())
    }

    @Test fun `leaving the form while it is saving answers nothing`() {
        val recorder = Recorder()
        val held = CompletableDeferred<String>()
        var showing by mutableStateOf(true)
        rule.setHappyContent {
            if (showing) {
                ConversationQuestionCard(
                    question = question(),
                    onAnswer = { recorder.answered += it },
                    secrets = SecretRequestActions(
                        secrets = { recorder.catalog },
                        create = { _, _, _ -> held.await() },
                    ),
                )
            }
        }
        fill()
        pinned(SecretRequestTags.SUBMIT).performClick()
        rule.waitForIdle()
        // The form goes away mid-save: its scope is cancelled, so an id that
        // arrives late is never answered with and nothing is left on screen.
        showing = false
        rule.waitForIdle()
        held.complete("made-deploy-api")
        rule.waitForIdle()
        assertTrue(recorder.answered.isEmpty())
        rule.node(SecretRequestTags.FORM).assertDoesNotExist()
    }
}
