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
import com.slopus.happy.genui.GenUiActions
import com.slopus.happy.genui.GenUiCapabilities
import com.slopus.happy.genui.GenUiHostKind
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
 * conversation to send it to, `secret` opens [secrets]' form. Which of them
 * may run at all is [GenUiActions.enabled] for a Happy Agent client: the
 * secret and message actions need the version's origin agent, `secret`
 * needs a Happy Agent computer that reports `artifactSecretActions` (a
 * Happy Cloud one serves `cluster_secret` instead, whose form this build
 * doesn't have yet), `plugin` opens [onPlugin] where the computer reports
 * `plugins`, and `tool` and anything unknown are drawn disabled. Pictures are the
 * version's own files, read through [media]; a tap on one opens the viewer
 * on its group.
 */
@Composable
fun rememberGenUiArtifactHost(
    ui: ArtifactUi.GenUi,
    media: ArtifactMedia,
    onOpenWeb: (String) -> Unit,
    onView: (items: List<ArtifactMediaItem>, index: Int) -> Unit,
    onMessage: ((String) -> Unit)? = null,
    secrets: GenUiSecretForm? = null,
    /** Opens a plugin's page; null where the computer doesn't report `capabilities.plugins`. */
    onPlugin: ((String) -> Unit)? = null,
): GenUiHost {
    val context = LocalContext.current
    val open by rememberUpdatedState(onOpenWeb)
    val view by rememberUpdatedState(onView)
    val message by rememberUpdatedState(onMessage)
    val plugin by rememberUpdatedState(onPlugin)
    val sends = onMessage != null
    val plugins = onPlugin != null
    return remember(ui, media, sends, secrets, plugins) {
        GenUiHost(
            onAction = { key, action ->
                when (action) {
                    is Action.Open -> if (isHttps(action.url)) open(action.url)
                    is Action.Copy -> copyToClipboard(context, action.text)
                    is Action.Message -> message?.invoke(action.text)
                    is Action.Secret -> secrets?.open(key, action)
                    is Action.Plugin -> plugin?.invoke(action.id)
                    is Action.ClusterSecret, is Action.Tool, is Action.Unsupported -> Unit
                }
            },
            onView = { _, viewer ->
                val group = ui.document.viewers[viewer.group].orEmpty()
                val items = group.mapNotNull { ui.pictures[it.file] }
                val wanted = group.getOrNull(viewer.index)?.let { ui.pictures[it.file] }
                if (items.isNotEmpty()) view(items, items.indexOf(wanted).coerceAtLeast(0))
            },
            supports = { action ->
                // Read in composition, so the button enables once the computer's health has said.
                val capabilities = GenUiCapabilities(secretActions = secrets?.served == true, plugins = plugins)
                GenUiActions.enabled(action, secrets?.host ?: GenUiHostKind.HappyAgent, origin = ui.origin != null, capabilities) && when (action) {
                    is Action.Open -> isHttps(action.url)
                    is Action.Message -> sends
                    is Action.Secret -> secrets != null
                    // Happy Cloud's own form isn't in this build yet.
                    is Action.ClusterSecret -> false
                    else -> true
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
fun GenUiArtifactView(ui: ArtifactUi.GenUi, host: GenUiHost, state: GenUiState, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxSize().verticalScroll(rememberScrollState()).testTag(GenUiArtifactTags.SCREEN), horizontalAlignment = Alignment.CenterHorizontally) {
        GenUiView(ui.document, Modifier.contentMaxWidth(LocalWindowLayout.current).fillMaxWidth().padding(vertical = 16.dp), host, state)
        Spacer(Modifier.windowInsetsBottomHeight(WindowInsets.navigationBars))
    }
}
