package com.slopus.happy.ui.documents

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.documents.DocumentEditor
import com.slopus.happy.documents.yjs.YDoc
import com.slopus.happy.ui.artifacts.PlaceTags
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.layout.ProvideWindowLayout
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/**
 * The document page at a phone, a Fold's inner screen and a tablet
 * ([DocumentScreenSpec]): the text view takes the pane's width and holds
 * its text to the content column's keylines (16 on a phone, the measure
 * centred beyond), 16 below the bar and 96 of room under its end; a status
 * stands centred in the text's place, at most 280 wide; the bar says where
 * saving stands.
 */
@RunWith(AndroidJUnit4::class)
abstract class DocumentPageLayoutTest(private val width: Int, private val keyline: Dp) {
    @get:Rule val rule = createComposeRule()

    private var controller: DocumentTextController? = null

    private fun show(phase: DocumentHolder.Phase, subtitle: String? = "Saved", dark: Boolean = false) {
        rule.setHappyContent(dark) {
            ProvideWindowLayout(Modifier.fillMaxSize()) {
                DocumentPage("Meeting notes", subtitle, phase, toolbar = false, active = emptySet(), onBack = {}) { editor ->
                    DocumentEditorView(editor, onController = { controller = it }, onSelection = { _, _ -> }, onFocus = {}, onLink = { _, _ -> })
                }
            }
        }
        rule.waitForIdle()
    }

    @Test
    fun theTextSpansThePaneWithItsTextOnTheKeylines() {
        show(DocumentHolder.Phase.Ready(DocumentEditor(YDoc(3))))
        rule.onNodeWithText("Meeting notes").assertExists()
        rule.node(PlaceTags.SUBTITLE).assertExists()
        val text = rule.node(DocumentScreenTags.TEXT).bounds
        assertDp("the pane's width", width.dp, text.right - text.left)
        val view = checkNotNull(controller) { "the editor was made" }.textView
        val density = view.resources.displayMetrics.density
        assertDp("leading keyline", keyline, (view.paddingLeft / density).dp)
        assertDp("trailing keyline", keyline, (view.paddingRight / density).dp)
        assertDp("16 below the bar", 16.dp, (view.paddingTop / density).dp)
        assertDp("96 under the end", 96.dp, (view.paddingBottom / density).dp)
        assertEquals("An empty document has a line to type in", "\n", view.text.toString())
    }

    @Test
    fun aStatusStandsCentredInTheTextsPlace() {
        show(DocumentHolder.Phase.Unavailable("The agent is restarting."), subtitle = null, dark = true)
        val status = rule.node(DocumentScreenTags.STATUS).bounds
        rule.onNodeWithText("This document couldn’t be opened.\nThe agent is restarting.").assertExists()
        assertDp("at most 280 wide", 280.dp, status.right - status.left)
        assertDp("centred", (width.dp - 280.dp) / 2, status.left)
    }

    @Test
    fun aMarkdownOnlyDocumentIsItsSourceOnTheKeylines() {
        show(DocumentHolder.Phase.Markdown("# Plan\n\nShip it."), subtitle = "Editing this document needs a newer Happy Agent.")
        val markdown = rule.node(DocumentScreenTags.MARKDOWN).bounds
        assertDp("pane wide, padded inside", width.dp, markdown.right - markdown.left)
        rule.onNodeWithText("# Plan\n\nShip it.").assertExists()
    }
}

@Config(qualifiers = "w411dp-h891dp-xxhdpi")
class DocumentPagePhoneTest : DocumentPageLayoutTest(411, 16.dp)

@Config(qualifiers = "w750dp-h832dp-xxhdpi")
class DocumentPageFoldTest : DocumentPageLayoutTest(750, 55.dp)

@Config(qualifiers = "w1280dp-h800dp-xhdpi")
class DocumentPageTabletTest : DocumentPageLayoutTest(1280, 256.dp)
