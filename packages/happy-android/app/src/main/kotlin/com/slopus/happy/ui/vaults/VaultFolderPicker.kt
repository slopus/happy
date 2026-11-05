package com.slopus.happy.ui.vaults

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.slopus.happy.R
import com.slopus.happy.agent.AgentSession
import com.slopus.happy.conversation.Conversation
import com.slopus.happy.ui.artifacts.PlaceMessage
import com.slopus.happy.ui.artifacts.PlaceScaffold
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.LoadingIndicator
import com.slopus.happy.ui.components.PageDialog
import com.slopus.happy.ui.components.RoundButton
import com.slopus.happy.ui.components.barInsetTop
import com.slopus.happy.ui.conversation.problemText
import com.slopus.happy.ui.layout.LocalWindowLayout
import com.slopus.happy.ui.layout.contentMaxWidth
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.vaults.VaultAncestor
import com.slopus.happy.vaults.VaultItem
import kotlinx.coroutines.CancellationException

object VaultPickerTags {
    const val PICKER = "vault.picker"
    const val FOLDER = "vault.picker.folder"
    const val CHOOSE = "vault.picker.choose"
}

/**
 * Where to move [moving] (the mobile stand-in for desktop's drag and
 * drop): a window over the vault that walks its folders from the one
 * [moving] is in, the root at the top. Each step lists the folder's
 * folders, never [moving] itself, so a folder can't go inside itself;
 * back (the bar's or the system's) goes up a level, then closes. "Move
 * here" at the foot picks the folder shown; it is off where [moving]
 * already is.
 */
@Composable
fun VaultFolderPicker(session: AgentSession, surfaceId: String, moving: VaultItem, onDismiss: () -> Unit, onPick: (String?) -> Unit) {
    val surface by remember(session, surfaceId) { session.surface(surfaceId) }.collectAsStateWithLifecycle(null)
    // The path from the root to the folder shown; empty is the root.
    val path = remember { mutableStateListOf<VaultAncestor>() }
    var started by remember { mutableStateOf(false) }
    LaunchedEffect(moving.id) {
        if (started) return@LaunchedEffect
        started = true
        val parent = moving.parentId ?: return@LaunchedEffect
        try {
            val location = session.vaults.routes.location(surfaceId, parent, folder = true)
            path.clear()
            path.addAll(location.ancestors + VaultAncestor(location.item.id, location.item.name))
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // Starts at the root.
        }
    }
    val here = path.lastOrNull()?.id
    var folders by remember(here) { mutableStateOf<List<VaultItem>?>(null) }
    var failure by remember(here) { mutableStateOf<String?>(null) }
    val resources = androidx.compose.ui.platform.LocalResources.current
    LaunchedEffect(here) {
        val all = ArrayList<VaultItem>()
        try {
            var page: String? = null
            do {
                val answer = session.vaults.routes.children(surfaceId, here, page)
                all += answer.items.filter { it.isFolder && it.id != moving.id }
                // Folders come first: a page that ends in a file has them all.
                if (answer.items.lastOrNull()?.isFolder == false) break
                page = answer.next
            } while (page != null)
            folders = all
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            failure = resources.problemText(Conversation.describe(e))
        }
    }
    val up: () -> Unit = { if (path.isEmpty()) onDismiss() else path.removeAt(path.lastIndex) }
    PageDialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        BackHandler { up() }
        val title = path.lastOrNull()?.name ?: surface?.name.orEmpty()
        Box(Modifier.fillMaxSize().background(HappyTheme.colors.surface).testTag(VaultPickerTags.PICKER)) {
            PlaceScaffold(title, onBack = up, tag = "vault.picker.screen", subtitle = stringResource(R.string.vaults_move_title, moving.shownName)) {
                Column(Modifier.fillMaxSize()) {
                    Box(Modifier.weight(1f)) {
                        val shown = folders
                        when {
                            failure != null -> Column(Modifier.padding(top = barInsetTop())) { PlaceMessage(failure.orEmpty()) }
                            shown == null -> LoadingIndicator()
                            shown.isEmpty() -> Column(Modifier.padding(top = barInsetTop())) { PlaceMessage(stringResource(R.string.vaults_no_folders)) }
                            else -> LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(top = barInsetTop())) {
                                items(shown, key = { it.id }) { folder ->
                                    FolderRow(folder) { path.add(VaultAncestor(folder.id, folder.name)) }
                                }
                            }
                        }
                    }
                    Box(Modifier.contentMaxWidth(LocalWindowLayout.current).fillMaxWidth().navigationBarsPadding().padding(16.dp)) {
                        RoundButton(
                            stringResource(R.string.vaults_move_here),
                            onClick = { onPick(here) },
                            enabled = here != moving.parentId,
                            modifier = Modifier.fillMaxWidth().testTag(VaultPickerTags.CHOOSE),
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun FolderRow(folder: VaultItem, onClick: () -> Unit) {
    val colors = HappyTheme.colors
    Row(
        Modifier
            .contentMaxWidth(LocalWindowLayout.current)
            .fillMaxWidth()
            .heightIn(min = VaultRowSpec.row)
            .testTag(VaultPickerTags.FOLDER)
            .clickable(role = Role.Button, onClick = onClick),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        VaultTile(folder, Modifier.padding(start = VaultRowSpec.tileX))
        Text(
            folder.name,
            style = VaultText.name,
            color = colors.text,
            maxLines = 1,
            overflow = TextOverflow.MiddleEllipsis,
            modifier = Modifier.padding(start = VaultRowSpec.textX - VaultRowSpec.tileX - VaultRowSpec.tile).weight(1f),
        )
        Icon(Ionicon.ChevronForward, 18.dp, colors.textSecondary, Modifier.padding(end = 16.dp))
    }
}
