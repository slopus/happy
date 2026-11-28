package com.slopus.happy.ui.genui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import com.slopus.happy.genui.Action
import com.slopus.happy.genui.GenUiMessage
import com.slopus.happy.genui.RenderDocument
import com.slopus.happy.ui.home.copyToClipboard

/**
 * Message content at the normal Gen UI inset, with no file/image loading or
 * privileged actions. `plugin` opens the plugin's page where the computer
 * reports `capabilities.plugins`, and reports nothing: direct Gen UI has no
 * artifact version to report from.
 */
@Composable
fun GenUiMessageBlock(identity: String, document: RenderDocument, inline: GenUiInline?, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val plugins = inline?.plugins?.collectAsState()?.value == true
    val host = remember(context, inline, plugins) {
        GenUiHost(
            supports = { GenUiMessage.enables(it, plugins) && (it !is Action.Message && it !is Action.Open && it !is Action.Plugin || inline != null) },
            onAction = { _, action ->
                if (GenUiMessage.enables(action, plugins)) when (action) {
                    is Action.Message -> inline?.onMessage?.invoke(action.text)
                    is Action.Open -> inline?.onOpenWeb?.invoke(action.url)
                    is Action.Plugin -> inline?.onOpenPlugin?.invoke(action.id, null)
                    is Action.Copy -> copyToClipboard(context, action.text)
                    else -> Unit
                }
            },
            cached = { null },
            load = { null },
        )
    }
    val state = remember(inline, identity, document) { inline?.messageState(identity) ?: GenUiState() }
    GenUiView(document, modifier.testTag("genui.message"), host, state)
}