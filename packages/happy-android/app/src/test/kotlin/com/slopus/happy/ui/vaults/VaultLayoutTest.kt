package com.slopus.happy.ui.vaults

import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.height
import androidx.compose.ui.unit.width
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.PHONE_WIDTH
import com.slopus.happy.ui.assertBox
import com.slopus.happy.ui.assertDp
import com.slopus.happy.ui.bounds
import com.slopus.happy.ui.node
import com.slopus.happy.ui.setHappyContent
import com.slopus.happy.vaults.VaultActivity
import com.slopus.happy.vaults.VaultItem
import com.slopus.happy.vaults.VaultFolderFeed
import com.slopus.happy.vaults.VaultRetention
import com.slopus.happy.vaults.VaultRetentionPreset
import com.slopus.happy.vaults.VaultSort
import com.slopus.happy.vaults.VaultUploads
import com.slopus.happy.vaults.VaultVersion
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class VaultLayoutTest {
    @get:Rule val rule = createComposeRule()

    private fun entry(id: String, name: String, kind: String = VaultItem.FILE, size: Long? = 2048) =
        VaultItem(id = id, surfaceId = "s1", name = name, kind = kind, size = size, latestVersion = 1, updatedAt = 1_700_000_000_000, version = "v1")

    private fun loaded(vararg entries: VaultItem) = VaultFolderFeed.State(entries.toList(), VaultSort(), loaded = true, complete = true, error = null, gone = false)

    @Test fun rowsAreTheDocumentRowAndOpenTheirEntry() {
        var opened: String? = null
        rule.setHappyContent {
            VaultFolderContent(loaded(entry("f", "Reports", VaultItem.FOLDER, null), entry("a", "summary.pdf")), emptyList(), null, { opened = it.id }, null)
        }
        val first = rule.node(VaultFolderTags.row("f")).bounds
        val second = rule.node(VaultFolderTags.row("a")).bounds
        assertDp("row height", VaultRowSpec.row, first.height)
        assertDp("rows touch", first.bottom, second.top)
        assertDp("row width", PHONE_WIDTH, first.width)
        val tile = rule.onAllNodesWithTag(VaultFolderTags.ROW_TILE, useUnmergedTree = true)[0].bounds
        assertBox("tile", tile, VaultRowSpec.tileX, first.top + 8.dp, VaultRowSpec.tile, VaultRowSpec.tile)
        val name = rule.onAllNodesWithTag(VaultFolderTags.ROW_NAME, useUnmergedTree = true)[0].bounds
        assertDp("name starts", VaultRowSpec.textX, name.left)
        val more = rule.onAllNodesWithTag(VaultFolderTags.ROW_MORE, useUnmergedTree = true).fetchSemanticsNodes()
        assertTrue("no More without actions", more.isEmpty())
        rule.onNodeWithText("Reports").assertExists()
        rule.onNodeWithText("summary.pdf").performClick()
        assertEquals("a", opened)
    }

    @Test fun anUploadShowsAboveTheEntriesWithItsProgress() {
        val task = VaultUploads.Task("t1", "s1", null, "movie.mp4", 4 * 1024 * 1024, sent = 1024 * 1024, status = VaultUploads.Status.Sending)
        var cancelled = false
        rule.setHappyContent {
            VaultFolderContent(loaded(entry("a", "a.txt")), listOf(task), null, {}, null, onCancelUpload = { cancelled = true })
        }
        val upload = rule.node(VaultFolderTags.UPLOAD).bounds
        val row = rule.node(VaultFolderTags.row("a")).bounds
        assertDp("upload row height", VaultRowSpec.row, upload.height)
        assertDp("entries follow", upload.bottom, row.top)
        rule.onNodeWithText("movie.mp4").assertExists()
        rule.node(VaultFolderTags.UPLOAD_CANCEL).performClick()
        assertTrue(cancelled)
    }

    @Test fun anEmptyFolderSaysSo() {
        rule.setHappyContent { VaultFolderContent(loaded(), emptyList(), null, {}, null) }
        rule.onNodeWithText("This folder is empty").assertExists()
    }

    @Test fun presetsAreOfferedInOrderAndChoosingOneKeepsTheTrash() {
        var saved: VaultRetention? = null
        val current = VaultRetention(trashDays = 90)
        rule.setHappyContent { VaultSettingsPage(current) { saved = it } }
        val tops = VaultRetentionPreset.offered.map { rule.node(VaultSettingsTags.preset(it)).bounds.top }
        assertEquals(tops.sorted(), tops)
        rule.onNodeWithText("Time Machine (default)").assertExists()
        rule.onNodeWithText("Every version for a day, then daily for a month, then weekly").assertExists()
        rule.node(VaultSettingsTags.preset(VaultRetentionPreset.LastTen)).performClick()
        assertEquals(VaultRetention(10, null, 0, emptyList(), 90), saved)
        rule.node(VaultSettingsTags.preset(VaultRetentionPreset.Custom)).performClick()
        rule.node(VaultSettingsTags.KEEP_ALL).assertExists()
        rule.node(VaultSettingsTags.ADD_TIER).assertExists()
    }

    @Test fun versionAndActivityRowsPutTheBadgeBeforeTheText() {
        rule.setHappyContent {
            androidx.compose.foundation.layout.Column {
                VersionRow(VaultVersion("e1", "s1", 3, size = 1024, pinned = true, createdAt = 1_700_000_000_000), true, "Steve", {}, null, {}, {})
                ActivityRow(VaultActivity("a1", "e1", "moved", fromParentId = null, toParentId = "f1", fromName = "a", toName = "a"), "Steve", mapOf("f1" to "Reports"))
            }
        }
        val version = rule.node(VaultHistoryTags.version(3)).bounds
        val activity = rule.node(VaultHistoryTags.ACTIVITY).bounds
        assertDp("version row starts", 0, version.left)
        assertTrue("version row holds the badge", version.height.value >= (VaultHistorySpec.badge + VaultHistorySpec.vertical * 2).value)
        assertDp("activity follows", version.bottom, activity.top)
        rule.node(VaultHistoryTags.PIN).assertExists()
        rule.onNodeWithText("Moved from the top of the vault to Reports").assertExists()
    }

    @Test fun snippetsMarkWhatWasSearched() {
        val text = highlight("…the Quarterly report is due…", "quarterly")
        val span = text.spanStyles.single()
        assertEquals("Quarterly", text.text.substring(span.start, span.end))
        assertEquals(FontWeight.SemiBold, span.item.fontWeight)
    }

    @Test fun anAppIsSharedAsItsFileUnderItsShownName() {
        val uri = android.net.Uri.parse("content://com.slopus.happy.dev.conversation.media/vault/rocket.artifact")
        val send = vaultShare(uri, VaultItem(id = "a1", name = "rocket.artifact", kind = VaultItem.ARTIFACT, version = "v1"))
        assertEquals(android.content.Intent.ACTION_SEND, send.action)
        assertEquals(uri, androidx.core.content.IntentCompat.getParcelableExtra(send, android.content.Intent.EXTRA_STREAM, android.net.Uri::class.java))
        assertEquals("rocket", send.getStringExtra(android.content.Intent.EXTRA_TITLE))
        assertEquals("rocket", send.clipData?.description?.label)
        assertEquals(uri, send.clipData?.getItemAt(0)?.uri)
        assertEquals("application/octet-stream", send.clipData?.description?.getMimeType(0))
        assertTrue(send.flags and android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION != 0)
    }
}
