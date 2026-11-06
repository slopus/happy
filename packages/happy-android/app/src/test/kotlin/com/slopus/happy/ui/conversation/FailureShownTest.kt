package com.slopus.happy.ui.conversation

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.Text
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.conversation.ConversationRow
import com.slopus.happy.conversation.FailureReason
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.chat.MessageCallbacks
import com.slopus.happy.ui.chat.userMessageBubblePalette
import com.slopus.happy.ui.components.LocalOverlays
import com.slopus.happy.ui.components.Overlays
import com.slopus.happy.ui.components.PageDialog
import com.slopus.happy.ui.setHappyContent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/**
 * `chat_failure_shown` is asked for only once a failure card is on the
 * screen: not when the list lays it out ahead, nor while a dialog covers it.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
class FailureShownTest {
    @get:Rule val rule = createComposeRule()

    @Test fun aCardBelowTheScreenIsNotShownUntilItIsScrolledTo() {
        val shown = ArrayList<String>()
        lateinit var list: LazyListState
        lateinit var scope: CoroutineScope
        rule.setHappyContent {
            val state = rememberLazyListState().also { list = it }
            scope = rememberCoroutineScope()
            val actions = ConversationRowActions(legacy = MessageCallbacks(), onRetryFailure = {}, onFailureShown = { shown += it.messageId }, loadMedia = { ByteArray(0) })
            LazyColumn(state = state, modifier = Modifier.height(400.dp)) {
                item { ConversationRowView(failure("top"), userMessageBubblePalette(null, false), actions) }
                items(20) { Spacer(Modifier.fillMaxWidth().height(300.dp)) }
                item { ConversationRowView(failure("bottom"), userMessageBubblePalette(null, false), actions) }
            }
        }
        rule.waitForIdle()
        assertEquals(listOf("top"), shown)
        rule.runOnIdle { scope.launch { list.scrollToItem(21) } }
        rule.waitForIdle()
        assertEquals(listOf("top", "bottom"), shown)
    }

    @Test fun aCardUnderADialogIsNotShownUntilTheDialogGoes() {
        val shown = ArrayList<String>()
        var dialog by mutableStateOf(true)
        rule.setHappyContent {
            CompositionLocalProvider(LocalOverlays provides remember { Overlays() }) {
                val actions = ConversationRowActions(legacy = MessageCallbacks(), onRetryFailure = {}, onFailureShown = { shown += it.messageId }, loadMedia = { ByteArray(0) })
                Column { ConversationRowView(failure("under"), userMessageBubblePalette(null, false), actions) }
                if (dialog) PageDialog(onDismissRequest = { dialog = false }) { Text("Over it") }
            }
        }
        rule.waitForIdle()
        assertEquals(emptyList<String>(), shown)
        rule.runOnIdle { dialog = false }
        rule.waitForIdle()
        assertEquals(listOf("under"), shown)
    }

    private fun failure(id: String) = ConversationRow.Failure("$id:failure", id, FailureReason.RateLimited("Claude"), retryable = true, resolved = false, kind = "rate_limited")
}
