package com.slopus.happy.ui.documents

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.documents.DocumentActor
import com.slopus.happy.documents.DocumentChange
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.layout.ProvideWindowLayout
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/**
 * A document's history on a phone ([DocumentHistorySpec]): newest first,
 * each row 16 in with a 36 face, 12 to the words and 10 above and below
 * the taller of the face and its two lines;
 * the newest says it is the current version; who made each change reads as
 * iOS says it.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "w411dp-h891dp-xxhdpi")
class DocumentHistoryLayoutTest {
    @get:Rule val rule = createComposeRule()

    private val changes = listOf(
        DocumentChange(3, DocumentActor(userId = "u1", agentId = "a1"), source = "tool", createdAt = 1_762_000_000_000.0, size = 2048),
        DocumentChange(2, DocumentActor(userId = "u1"), createdAt = 1_761_000_000_000.0, size = 300),
        DocumentChange(1, source = "conversion", createdAt = 1_760_000_000_000.0, size = 900),
    )

    private fun show(state: DocumentHistoryState, onPick: (DocumentChange, String) -> Unit = { _, _ -> }) {
        rule.setHappyContent {
            ProvideWindowLayout(Modifier.fillMaxSize()) { DocumentHistoryPage(state, onBack = {}, onPick = onPick) }
        }
        rule.waitForIdle()
    }

    @Test
    fun rowsAreNewestFirstOnTheirMetrics() {
        var picked: Pair<Int, String>? = null
        show(DocumentHistoryState(changes, failed = false, names = mapOf("u1" to "Steve"))) { change, author -> picked = change.seq to author }
        val newest = rule.node(DocumentHistoryTags.row(3)).bounds
        val next = rule.node(DocumentHistoryTags.row(2)).bounds
        val oldest = rule.node(DocumentHistoryTags.row(1)).bounds
        assertTrue("newest first", newest.top < next.top && next.top < oldest.top)
        assertDp("the phone's width", 411.dp, newest.right - newest.left)
        assertDp("the two lines (22, 2, 18) taller than the 36 face, 10 above and below", 62.dp, newest.bottom - newest.top)
        rule.onNodeWithText("Steve · An agent").assertExists()
        rule.onNodeWithText("Steve").assertExists()
        rule.onNodeWithText("Made from Markdown").assertExists()
        rule.onNodeWithText("Current version", substring = true).assertExists()
        rule.onNodeWithText("Steve").performClick()
        assertEquals(2 to "Steve", picked)
    }

    @Test
    fun anAuthorWithAPhotoWearsItRoundInTheFacesPlace() {
        show(DocumentHistoryState(changes, failed = false, names = mapOf("u1" to "Steve"), photos = mapOf("u1" to "1QcSHQRnh493V4dIh4eXh1h4kJUI")))
        val faces = rule.onAllNodesWithTag(DocumentHistoryTags.FACE, useUnmergedTree = true)
        // Both of u1's changes; the conversion keeps its initial.
        faces.assertCountEquals(2)
        val face = faces[0].bounds
        val row = rule.node(DocumentHistoryTags.row(3)).bounds
        assertDp("36 round", 36.dp, face.right - face.left)
        assertDp("16 in", 16.dp, face.left - row.left)
        assertDp("centred in its 62 row", 13.dp, face.top - row.top)
    }

    @Test
    fun emptyAndFailedSayWhy() {
        show(DocumentHistoryState(emptyList(), failed = false, names = emptyMap()))
        rule.node(DocumentHistoryTags.STATUS).assertExists()
        rule.onNodeWithText("No changes yet").assertExists()
    }

    @Test
    fun authorsReadAsIosSaysThem() {
        val words = HistoryWords(conversion = "Made from Markdown", agent = "An agent", someone = "Someone", current = "Current version")
        assertEquals("An agent", words.author(DocumentChange(1, DocumentActor(agentId = "a"), source = "tool"), emptyMap()))
        assertEquals("An agent", words.author(DocumentChange(1, source = "tool"), emptyMap()))
        assertEquals("Someone", words.author(DocumentChange(1, DocumentActor(userId = "u")), emptyMap()))
        assertEquals("Ann", words.author(DocumentChange(1, DocumentActor(userId = "u")), mapOf("u" to "Ann")))
        assertEquals("Made from Markdown", words.author(DocumentChange(1, DocumentActor(userId = "u"), source = "conversion"), mapOf("u" to "Ann")))
    }
}
