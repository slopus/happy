package com.slopus.happy.ui.genui

import android.net.Uri
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.windowInsetsBottomHeight
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.slopus.happy.artifacts.ArtifactMedia
import com.slopus.happy.artifacts.ArtifactMediaItem
import com.slopus.happy.genui.Action
import com.slopus.happy.ui.artifacts.ArtifactUi
import com.slopus.happy.ui.home.copyToClipboard
import com.slopus.happy.ui.layout.LocalWindowLayout
import com.slopus.happy.ui.layout.contentMaxWidth

object GenUiArtifactTags {
    const val SCREEN = "genui.artifact"
}

/**
 * Runs what a Gen UI version's controls ask for, as if the person had done
 * it (desktop's `genUiInlineHostCreate`): `open` opens an https address,
 * `copy` copies, `message` goes to [onMessage] where there is a
 * conversation to send it to. Anything else, `tool` included, is drawn
 * disabled. Pictures are the version's own files, read through [media]; a
 * tap on one opens the viewer on its group.
 */
@Composable
fun rememberGenUiArtifactHost(
    ui: ArtifactUi.GenUi,
    media: ArtifactMedia,
    onOpenWeb: (String) -> Unit,
    onView: (items: List<ArtifactMediaItem>, index: Int) -> Unit,
    onMessage: ((String) -> Unit)? = null,
): GenUiHost {
    val context = LocalContext.current
    val open by rememberUpdatedState(onOpenWeb)
    val view by rememberUpdatedState(onView)
    val message by rememberUpdatedState(onMessage)
    val sends = onMessage != null
    return remember(ui, media, sends) {
        GenUiHost(
            onAction = { _, action ->
                when (action) {
                    is Action.Open -> if (isHttps(action.url)) open(action.url)
                    is Action.Copy -> copyToClipboard(context, action.text)
                    is Action.Message -> message?.invoke(action.text)
                    is Action.Tool, is Action.Unsupported -> Unit
                }
            },
            onView = { _, viewer ->
                val group = ui.document.viewers[viewer.group].orEmpty()
                val items = group.mapNotNull { ui.pictures[it.file] }
                val wanted = group.getOrNull(viewer.index)?.let { ui.pictures[it.file] }
                if (items.isNotEmpty()) view(items, items.indexOf(wanted).coerceAtLeast(0))
            },
            supports = { action ->
                when (action) {
                    is Action.Open -> isHttps(action.url)
                    is Action.Copy -> true
                    is Action.Message -> sends
                    is Action.Tool, is Action.Unsupported -> false
                }
            },
            cached = { path -> ui.pictures[path]?.let { media.cached(it.key) } },
            load = { path -> ui.pictures[path]?.let { media.data(it.key) } },
            key = { path -> ui.pictures[path]?.key },
        )
    }
}

/** The model wrote these addresses: only https opens. */
internal fun isHttps(url: String): Boolean = runCatching { Uri.parse(url).scheme.equals("https", ignoreCase = true) }.getOrDefault(false)

/** A Gen UI version on the artifact screen: the block in the reading column, scrolling. */
@Composable
fun GenUiArtifactView(ui: ArtifactUi.GenUi, host: GenUiHost, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxSize().verticalScroll(rememberScrollState()).testTag(GenUiArtifactTags.SCREEN), horizontalAlignment = Alignment.CenterHorizontally) {
        GenUiView(ui.document, Modifier.contentMaxWidth(LocalWindowLayout.current).fillMaxWidth().padding(vertical = 16.dp), host)
        Spacer(Modifier.windowInsetsBottomHeight(WindowInsets.navigationBars))
    }
}
