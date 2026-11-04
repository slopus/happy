package com.slopus.happy.ui.documents

import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.documents.DocumentPeer
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/**
 * The faces beside a document's title ([DocumentPeersSpec]): 28 across,
 * each 8 over the one before, at most three and then "+N", read as who is
 * here.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "w411dp-h891dp-xxhdpi")
class DocumentPeersTest {
    @get:Rule val rule = createComposeRule()

    private fun peer(name: String) = DocumentPeer(name, name.length.toLong(), name, "#70CFF8")

    @Test
    fun threeFacesOverlapThenACount() {
        rule.setHappyContent { DocumentPeers(listOf("Ann", "Bo", "Cy", "Di", "Ed").map(::peer)) }
        val first = rule.node(DocumentPeersTags.face(0)).bounds
        val second = rule.node(DocumentPeersTags.face(1)).bounds
        assertDp("28 across", 28.dp, first.right - first.left)
        assertDp("8 over the one before", 20.dp, second.left - first.left)
        rule.onAllNodesWithTag(DocumentPeersTags.face(3), useUnmergedTree = true).assertCountEquals(0)
        rule.onNodeWithText("+2", useUnmergedTree = true).assertExists()
        val more = rule.node(DocumentPeersTags.MORE).bounds
        assertDp("4 after the last face", 4.dp, more.left - (first.left + 20.dp * 2 + 28.dp))
        rule.onNode(SemanticsMatcher.expectValue(SemanticsProperties.ContentDescription, listOf("Ann, Bo, Cy, Di, and Ed are here"))).assertExists()
    }

    @Test
    fun oneIsHereAndNoneShowsNothing() {
        rule.setHappyContent { DocumentPeers(listOf(peer("Ann"))) }
        rule.onNode(SemanticsMatcher.expectValue(SemanticsProperties.ContentDescription, listOf("Ann is here"))).assertExists()
        rule.onAllNodesWithTag(DocumentPeersTags.MORE, useUnmergedTree = true).assertCountEquals(0)
    }
}
