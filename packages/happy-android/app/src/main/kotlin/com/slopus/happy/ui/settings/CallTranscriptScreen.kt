package com.slopus.happy.ui.settings

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.widget.Toast
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.IconButton
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import com.slopus.happy.call.CallController
import com.slopus.happy.call.CallTranscript
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.Screen
import com.slopus.happy.ui.components.StackHeader
import com.slopus.happy.ui.components.barInsetTop
import com.slopus.happy.ui.home.copyToClipboard
import com.slopus.happy.ui.theme.AppMono
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.text.DateFormat
import java.util.Date

object CallTranscriptTags {
    const val EMPTY = "callTranscript.empty"
    const val LIST = "callTranscript.list"
}

/**
 * Developer mode's Last voice call transcript (iOS `CallTranscriptViewController`):
 * when the last call started and how long it ran, then everything it
 * exchanged with the voice connection, each with its local time and kind
 * ([CallTranscript]). Copy puts it all on the clipboard; Share hands it on
 * as a text file, which a transcript too long for the clipboard still fits.
 * In English only, as developer mode's rows are.
 */
@Composable
fun CallTranscriptScreen(transcript: CallTranscript, onBack: () -> Unit) {
    val colors = HappyTheme.colors
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var loaded by remember { mutableStateOf(false) }
    var recording by remember { mutableStateOf<CallTranscript.Recording?>(null) }
    LaunchedEffect(transcript) {
        recording = withContext(Dispatchers.IO) { transcript.read() }
        loaded = true
    }
    Screen(header = {
        StackHeader("Last voice call", onBack) {
            recording?.let { shown ->
                IconButton(onClick = {
                    scope.launch {
                        val text = withContext(Dispatchers.Default) { shown.text() }
                        val copied = copyToClipboard(context, text)
                        Toast.makeText(context, if (copied) "Copied" else "Too long to copy: share it instead", Toast.LENGTH_SHORT).show()
                    }
                }) { Icon(Ionicon.CopyOutline, 22.dp, LocalContentColor.current, contentDescription = "Copy") }
                IconButton(onClick = { scope.launch { share(context, shown) } }) {
                    Icon(Ionicon.ShareOutline, 22.dp, LocalContentColor.current, contentDescription = "Share")
                }
            }
        }
    }) {
        val shown = recording
        when {
            !loaded -> Unit
            shown == null -> Box(Modifier.fillMaxSize().padding(40.dp), contentAlignment = Alignment.Center) {
                Text(
                    "No voice call yet. The next call's transcript shows here.",
                    style = happyTextStyle(fontSize = 16, lineHeight = 24),
                    color = colors.textSecondary,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.testTag(CallTranscriptTags.EMPTY),
                )
            }
            else -> LazyColumn(
                Modifier.fillMaxSize().testTag(CallTranscriptTags.LIST),
                contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = barInsetTop() + 8.dp, bottom = 24.dp),
            ) {
                item {
                    val started = DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.MEDIUM).format(Date(shown.started))
                    val details = listOfNotNull(
                        "Started $started",
                        "Duration ${CallController.clock(shown.duration / 1000)}",
                        shown.language?.let { "Language $it" },
                        "Truncated: the rest wasn't kept".takeIf { shown.truncated },
                    )
                    Text(details.joinToString("\n"), style = happyTextStyle(fontSize = 15, lineHeight = 22), color = colors.text, modifier = Modifier.padding(bottom = 8.dp))
                }
                items(shown.entries) { entry ->
                    Column(Modifier.padding(vertical = 8.dp)) {
                        Text(entry.heading(), style = happyTextStyle(fontSize = 13, lineHeight = 18, weight = FontWeight.SemiBold), color = if (entry.isError) colors.textDestructive else colors.textSecondary)
                        SelectionContainer {
                            Text(entry.text, style = happyTextStyle(fontSize = 13, lineHeight = 18).copy(fontFamily = AppMono), color = colors.text)
                        }
                    }
                }
            }
        }
    }
}

/** The transcript as a text file in the share sheet: only its own folder of the cache is handed out. */
private suspend fun share(context: Context, recording: CallTranscript.Recording) {
    try {
        val file = withContext(Dispatchers.IO) {
            File(context.cacheDir, "call-transcript").apply { mkdirs() }.resolve("last-voice-call.txt").apply { writeText(recording.text()) }
        }
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.conversation.media", file)
        val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        context.startActivity(Intent.createChooser(send, null).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    } catch (_: ActivityNotFoundException) {
    } catch (_: IllegalArgumentException) {
    }
}
