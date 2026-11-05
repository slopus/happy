package com.slopus.happy.ui.vaults

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.slopus.happy.R
import com.slopus.happy.agent.AgentApiException
import com.slopus.happy.agent.AgentSession
import com.slopus.happy.ui.artifacts.PlaceMessage
import com.slopus.happy.ui.artifacts.PlaceScaffold
import com.slopus.happy.ui.artifacts.PlaceTags
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.HappyAlert
import com.slopus.happy.ui.components.HappyDropdownMenu
import com.slopus.happy.ui.components.HappyMenuDivider
import com.slopus.happy.ui.components.HappyMenuItem
import com.slopus.happy.ui.components.HappyMenuSection
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.LoadingIndicator
import com.slopus.happy.ui.components.barInsetTop
import com.slopus.happy.ui.conversation.problemText
import com.slopus.happy.ui.layout.LocalWindowLayout
import com.slopus.happy.ui.layout.contentMaxWidth
import com.slopus.happy.ui.surfaces.SeedlingEmpty
import com.slopus.happy.ui.surfaces.SurfaceMenu
import com.slopus.happy.ui.surfaces.surfaceTitle
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.vaults.VaultItem
import com.slopus.happy.vaults.VaultEvent
import com.slopus.happy.vaults.VaultFolderFeed
import com.slopus.happy.vaults.VaultLocation
import com.slopus.happy.vaults.VaultNames
import com.slopus.happy.vaults.VaultPreview
import com.slopus.happy.vaults.VaultSort
import com.slopus.happy.vaults.VaultSortField
import com.slopus.happy.vaults.VaultUploads
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

object VaultFolderTags {
    const val SCREEN = "vault.folder"
    const val LIST = "vault.folder.list"
    const val ROW = "vault.row"
    const val ROW_TILE = "vault.row.tile"
    const val ROW_NAME = "vault.row.name"
    const val ROW_META = "vault.row.meta"
    const val ROW_MORE = "vault.row.more"
    const val UPLOAD = "vault.upload"
    const val UPLOAD_CANCEL = "vault.upload.cancel"
    const val SEARCH = "vault.search"
    const val ADD = "vault.add"
    const val MORE = "vault.more"
    const val LOADER = PlaceTags.LOADER
    fun row(id: String) = "vault.row.$id"
}

/**
 * A row of a vault's folder, Telegram's document row as the workspace
 * browser draws it ([com.slopus.happy.ui.files.WorkspaceFilesSpec]): 56
 * tall, a 40 tile 12 in (rounded 8), the name (16) and its line (13) from
 * 72, and a 48 More target at the end; a hairline from 72 under every row
 * but the last.
 */
object VaultRowSpec {
    val row = 56.dp
    val tile = 40.dp
    val tileX = 12.dp
    val tileCorner = 8.dp
    val glyph = 22.dp
    val textX = 72.dp
    val more = 48.dp
    val ring = 28.dp
}

internal class VaultFolderModel(val session: AgentSession, val surfaceId: String, val folderId: String?) : ViewModel() {
    val feed: VaultFolderFeed = session.vaults.folder(viewModelScope, surfaceId, folderId, session.vaults.sort(surfaceId)).also { it.start() }
    private val placeFlow = MutableStateFlow<VaultLocation?>(null)

    /** Where a folder below the root is, read again when it or a folder above it changes. */
    val place: StateFlow<VaultLocation?> = placeFlow.asStateFlow()

    init {
        if (folderId != null) viewModelScope.launch {
            read()
            session.vaults.events.collect { event ->
                val touched = when (event) {
                    VaultEvent.Resync -> true
                    is VaultEvent.Updated -> event.itemId == folderId || placeFlow.value?.ancestors?.any { it.id == event.itemId } == true
                    is VaultEvent.Known -> event.item.id == folderId
                    else -> false
                }
                if (touched) read()
            }
        }
    }

    private suspend fun read() {
        val id = folderId ?: return
        try {
            placeFlow.value = session.vaults.routes.location(surfaceId, id, folder = true)
        } catch (e: CancellationException) {
            throw e
        } catch (_: AgentApiException) {
            // A folder that is gone says so through its listing.
        } catch (_: Exception) {
            // Offline: the title it was opened with stays.
        }
    }

    fun sort(next: VaultSort) {
        session.vaults.setSort(surfaceId, next)
        feed.sort(next)
    }
}

/**
 * One folder of a vault, Finder's window one level per screen (the
 * vault's root is its Surface's page): the bar titled by the folder, its
 * path under it, Search, Add (upload photos and videos, upload files, new
 * folder) and More (sort, Trash, settings, download as a zip, and at the
 * root the Surface's own menu). Below, the uploads going into this folder,
 * then its entries, folders first, in the vault's sort, live as anyone
 * changes them. A tap opens a folder, a picture or recording in the
 * viewer with the folder's others, anything else on its own page; a long
 * press or the row's More offers what can be done to it.
 */
@Composable
fun VaultFolderScreen(session: AgentSession, surfaceId: String, folderId: String?, name: String, onBack: () -> Unit, open: (Any) -> Unit) {
    val model = viewModel(key = "vault:${session.connectionId}:$surfaceId:${folderId ?: "root"}") { VaultFolderModel(session, surfaceId, folderId) }
    val state by model.feed.state.collectAsStateWithLifecycle()
    val place by model.place.collectAsStateWithLifecycle()
    val surface by remember(session, surfaceId) { session.surface(surfaceId) }.collectAsStateWithLifecycle(null)
    val tasks by session.vaults.uploads.tasks.collectAsStateWithLifecycle()
    val uploads = remember(tasks, folderId) { tasks.filter { it.surfaceId == surfaceId && it.parentId == folderId } }
    val actions = rememberVaultActions(session, surfaceId, open)
    var viewing by remember { mutableStateOf<Pair<List<VaultItem>, Int>?>(null) }
    val vaultName = surface?.name.orEmpty()
    val title = if (folderId == null) surfaceTitle(session, vaultName.ifEmpty { name }) else place?.item?.shownName ?: VaultNames.shown(name)
    val subtitle = when {
        folderId == null -> null
        place?.inTrash == true -> stringResource(R.string.vaults_in_trash)
        else -> place?.let { location -> (listOf(vaultName) + location.ancestors.map { it.name }).filter { it.isNotEmpty() }.joinToString(" › ") }
    }
    val openEntry: (VaultItem) -> Unit = { entry ->
        when {
            entry.isFolder -> open(VaultFolderRoute(session.connectionId, surfaceId, entry.id, entry.name))
            VaultPreview.inViewer(entry) -> {
                val media = state.entries.filter(VaultPreview::inViewer)
                viewing = media to media.indexOfFirst { it.id == entry.id }.coerceAtLeast(0)
            }
            else -> open(VaultFileRoute(session.connectionId, surfaceId, entry.id, name = entry.shownName))
        }
    }
    PlaceScaffold(title, onBack, VaultFolderTags.SCREEN, subtitle = subtitle, actions = {
        IconButton(onClick = { open(VaultSearchRoute(session.connectionId, surfaceId)) }, modifier = Modifier.testTag(VaultFolderTags.SEARCH)) {
            Icon(Ionicon.SearchOutline, 24.dp, HappyTheme.colors.text, contentDescription = stringResource(R.string.vaults_search))
        }
        AddMenu(onMedia = { actions.uploadMedia(folderId) }, onFiles = { actions.uploadFiles(folderId) }, onFolder = { actions.newFolder(folderId) })
        val items: @Composable ColumnScope.(close: () -> Unit) -> Unit = { close ->
            SortItems(state.sort, close) { model.sort(it) }
            HappyMenuDivider()
            HappyMenuItem(stringResource(R.string.vaults_trash), onClick = { close(); open(VaultTrashRoute(session.connectionId, surfaceId)) }, leading = { MenuGlyph(Ionicon.TrashOutline) })
            HappyMenuItem(stringResource(R.string.vaults_settings), onClick = { close(); open(VaultSettingsRoute(session.connectionId, surfaceId)) }, leading = { MenuGlyph(Ionicon.SettingsOutline) })
            val folder = place?.item
            if (folderId == null) {
                HappyMenuItem(stringResource(R.string.vaults_download_vault), onClick = { close(); actions.save(VaultRootItem.of(surfaceId, vaultName)) }, leading = { MenuGlyph(Ionicon.DownloadOutline) })
            } else if (folder != null) {
                HappyMenuDivider()
                VaultItemMenuItems(folder, actions, close, inTrash = place?.inTrash == true)
            }
        }
        if (folderId == null) SurfaceMenu(session, surfaceId, onBack, open = open, extraItems = items)
        else MoreMenu(items)
    }) {
        VaultFolderContent(state, uploads, actions, openEntry, folderId)
    }
    uploads.firstOrNull { it.status == VaultUploads.Status.NameTaken }?.let { task -> NameTakenAlert(session, task) }
    viewing?.let { (items, index) -> VaultMediaViewer(session, items, index) { viewing = null } }
    VaultActionsHost(actions)
}

/** The folder's body: what is being read, why it can't be, its uploads and its entries. */
@Composable
internal fun VaultFolderContent(
    state: VaultFolderFeed.State,
    uploads: List<VaultUploads.Task>,
    actions: VaultActions?,
    onOpen: (VaultItem) -> Unit,
    folderId: String?,
    onCancelUpload: (VaultUploads.Task) -> Unit = { actions?.session?.vaults?.uploads?.cancel(it.id) },
    onRetryUpload: (VaultUploads.Task) -> Unit = { actions?.session?.vaults?.uploads?.retry(it.id) },
) {
    when {
        state.gone -> SeedlingEmpty(stringResource(R.string.vaults_folder_gone))
        !state.loaded && state.error != null -> Column(Modifier.fillMaxSize().padding(top = barInsetTop())) {
            PlaceMessage(problemText(state.error))
        }
        !state.loaded -> LoadingIndicator(Modifier.testTag(VaultFolderTags.LOADER))
        state.empty && uploads.isEmpty() -> SeedlingEmpty(
            stringResource(R.string.vaults_folder_empty),
            button = actions?.let { stringResource(R.string.vaults_upload_files) to { it.uploadFiles(folderId) } },
        )
        else -> LazyColumn(
            Modifier.fillMaxSize().testTag(VaultFolderTags.LIST),
            contentPadding = PaddingValues(top = barInsetTop(), bottom = 32.dp),
        ) {
            items(uploads, key = { "upload-${it.id}" }, contentType = { "upload" }) { task ->
                VaultUploadRow(task, onCancel = { onCancelUpload(task) }, onRetry = { onRetryUpload(task) })
            }
            items(state.entries, key = { it.id }, contentType = { "entry" }) { entry ->
                VaultItemRow(entry, last = entry === state.entries.last(), actions = actions, onClick = { onOpen(entry) })
            }
        }
    }
}

/** One entry: its tile, its name over what it is, and More with what can be done to it, also on a long press. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
internal fun VaultItemRow(
    entry: VaultItem,
    last: Boolean,
    actions: VaultActions?,
    onClick: () -> Unit,
    detail: String? = null,
    inTrash: Boolean = false,
) {
    val colors = HappyTheme.colors
    var menu by remember { mutableStateOf(false) }
    val divider = colors.divider
    Box(Modifier.contentMaxWidth(LocalWindowLayout.current).fillMaxWidth()) {
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = VaultRowSpec.row)
                .testTag(VaultFolderTags.row(entry.id))
                .combinedClickable(role = Role.Button, onClick = onClick, onLongClick = if (actions != null) ({ menu = true }) else null)
                .drawBehind {
                    if (!last) {
                        val y = size.height - 0.5f
                        drawLine(divider, Offset(VaultRowSpec.textX.toPx(), y), Offset(size.width, y), 1f)
                    }
                },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            VaultTile(entry, Modifier.padding(start = VaultRowSpec.tileX))
            Column(
                Modifier
                    .padding(start = VaultRowSpec.textX - VaultRowSpec.tileX - VaultRowSpec.tile, end = if (actions == null) 16.dp else 0.dp)
                    .weight(1f)
                    .padding(vertical = 8.dp),
            ) {
                Text(entry.shownName, style = VaultText.name, color = colors.text, maxLines = 1, overflow = TextOverflow.MiddleEllipsis, modifier = Modifier.testTag(VaultFolderTags.ROW_NAME))
                Text(
                    detail ?: vaultItemDetail(entry),
                    style = VaultText.meta,
                    color = colors.textSecondary,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.padding(top = 2.dp).testTag(VaultFolderTags.ROW_META),
                )
            }
            if (actions != null) {
                IconButton(onClick = { menu = true }, modifier = Modifier.size(VaultRowSpec.more).testTag(VaultFolderTags.ROW_MORE)) {
                    Icon(Ionicon.EllipsisVertical, 20.dp, colors.textSecondary, contentDescription = stringResource(R.string.vaults_more_actions, entry.shownName))
                }
            }
        }
        if (actions != null) {
            Box(Modifier.align(Alignment.TopEnd)) {
                HappyDropdownMenu(menu, onDismissRequest = { menu = false }) {
                    VaultItemMenuItems(entry, actions, { menu = false }, inTrash = inTrash)
                }
            }
        }
    }
}

/** The 40 tile: a folder's, an app's, or the file's own icon. */
@Composable
internal fun VaultTile(entry: VaultItem, modifier: Modifier = Modifier) {
    val colors = HappyTheme.colors
    Box(
        modifier
            .size(VaultRowSpec.tile)
            .clip(RoundedCornerShape(VaultRowSpec.tileCorner))
            .background(colors.surfaceHigh)
            .testTag(VaultFolderTags.ROW_TILE),
        contentAlignment = Alignment.Center,
    ) {
        when {
            entry.isFolder -> Icon(Ionicon.Folder, VaultRowSpec.glyph, colors.textLink)
            entry.isArtifact -> Icon(Ionicon.AppsOutline, VaultRowSpec.glyph, colors.textLink)
            else -> com.slopus.happy.ui.files.FileIcon(entry.name, VaultRowSpec.glyph)
        }
    }
}

/** An upload into this folder: a ring for how much has gone, the name over how it is going, and Cancel. A failed one retries on a tap. */
@Composable
internal fun VaultUploadRow(task: VaultUploads.Task, onCancel: () -> Unit, onRetry: () -> Unit) {
    val colors = HappyTheme.colors
    Row(
        Modifier
            .contentMaxWidth(LocalWindowLayout.current)
            .fillMaxWidth()
            .heightIn(min = VaultRowSpec.row)
            .testTag(VaultFolderTags.UPLOAD)
            .combinedClickableIf(task.status == VaultUploads.Status.Failed && !task.refused, onRetry),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier.padding(start = VaultRowSpec.tileX).size(VaultRowSpec.tile).clip(RoundedCornerShape(VaultRowSpec.tileCorner)).background(colors.surfaceHigh),
            contentAlignment = Alignment.Center,
        ) {
            when (task.status) {
                VaultUploads.Status.Failed -> Icon(Ionicon.AlertCircleOutline, VaultRowSpec.glyph, colors.textDestructive)
                VaultUploads.Status.Sending -> CircularProgressIndicator(progress = { task.progress }, modifier = Modifier.size(VaultRowSpec.ring), color = colors.textLink, strokeWidth = 3.dp, trackColor = colors.divider)
                else -> CircularProgressIndicator(Modifier.size(VaultRowSpec.ring), color = colors.textLink, strokeWidth = 3.dp)
            }
        }
        Column(Modifier.padding(start = VaultRowSpec.textX - VaultRowSpec.tileX - VaultRowSpec.tile).weight(1f).padding(vertical = 8.dp)) {
            Text(VaultNames.shown(task.name), style = VaultText.name, color = colors.text, maxLines = 1, overflow = TextOverflow.MiddleEllipsis)
            Text(uploadDetail(task), style = VaultText.meta, color = if (task.status == VaultUploads.Status.Failed) colors.textDestructive else colors.textSecondary, maxLines = if (task.status == VaultUploads.Status.Failed) 3 else 1, modifier = Modifier.padding(top = 2.dp))
        }
        IconButton(onClick = onCancel, modifier = Modifier.size(VaultRowSpec.more).testTag(VaultFolderTags.UPLOAD_CANCEL)) {
            Icon(Ionicon.Close, 20.dp, colors.textSecondary, contentDescription = stringResource(R.string.common_cancel))
        }
    }
}

@Composable
private fun uploadDetail(task: VaultUploads.Task): String = when (task.status) {
    VaultUploads.Status.Waiting -> stringResource(R.string.vaults_upload_waiting)
    VaultUploads.Status.Sending -> stringResource(R.string.vaults_uploading, vaultBytes(task.sent, task.size))
    VaultUploads.Status.Placing, VaultUploads.Status.NameTaken -> stringResource(R.string.vaults_upload_finishing)
    VaultUploads.Status.Failed -> {
        val reason = task.problem?.let { problemText(it) }
        when {
            // The daemon's own words for why it can't take it, with nothing to try again.
            task.refused && reason != null -> reason
            reason != null -> stringResource(R.string.vaults_upload_failed_reason, reason.trimEnd('.', '。'))
            else -> stringResource(R.string.vaults_upload_failed)
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
private fun Modifier.combinedClickableIf(enabled: Boolean, onClick: () -> Unit): Modifier =
    if (enabled) combinedClickable(role = Role.Button, onClick = onClick) else this

/** "“x” is already here": replace it (a new version of it), keep both, or don't upload. */
@Composable
private fun NameTakenAlert(session: AgentSession, task: VaultUploads.Task) {
    val uploads = session.vaults.uploads
    HappyAlert(
        Alert(
            title = stringResource(R.string.vaults_name_taken_title, VaultNames.shown(task.name)),
            message = stringResource(R.string.vaults_name_taken_message),
            buttons = listOf(
                AlertButton(stringResource(R.string.common_cancel)) { uploads.cancel(task.id) },
                AlertButton(stringResource(R.string.vaults_keep_both)) { uploads.resolve(task.id, VaultUploads.Choice.KeepBoth) },
                AlertButton(stringResource(R.string.vaults_replace)) { uploads.resolve(task.id, VaultUploads.Choice.Replace) },
            ),
            cancelable = false,
        ),
        onDismiss = {},
    )
}

@Composable
private fun AddMenu(onMedia: () -> Unit, onFiles: () -> Unit, onFolder: () -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    Box {
        IconButton(onClick = { expanded = true }, modifier = Modifier.testTag(VaultFolderTags.ADD)) {
            Icon(Ionicon.Add, 26.dp, HappyTheme.colors.text, contentDescription = stringResource(R.string.vaults_add))
        }
        HappyDropdownMenu(expanded, onDismissRequest = { expanded = false }) {
            HappyMenuItem(stringResource(R.string.vaults_upload_media), onClick = { expanded = false; onMedia() }, leading = { MenuGlyph(Ionicon.ImageOutline) })
            HappyMenuItem(stringResource(R.string.vaults_upload_files), onClick = { expanded = false; onFiles() }, leading = { MenuGlyph(Ionicon.CloudUploadOutline) })
            HappyMenuItem(stringResource(R.string.vaults_new_folder), onClick = { expanded = false; onFolder() }, leading = { MenuGlyph(Ionicon.FolderOutline) })
        }
    }
}

/** A folder's More, below the root (where the Surface's own menu holds these). */
@Composable
internal fun MoreMenu(items: @Composable ColumnScope.(close: () -> Unit) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    Box {
        IconButton(onClick = { expanded = true }, modifier = Modifier.size(48.dp).testTag(VaultFolderTags.MORE)) {
            Icon(Ionicon.EllipsisVertical, 24.dp, HappyTheme.colors.text, contentDescription = stringResource(R.string.conversation_composer_more))
        }
        HappyDropdownMenu(expanded, onDismissRequest = { expanded = false }) { items { expanded = false } }
    }
}

/** "Sort by": name, date modified, size; the one in use checked with its direction, picked again to turn it round. */
@Composable
private fun SortItems(sort: VaultSort, close: () -> Unit, onSort: (VaultSort) -> Unit) {
    HappyMenuSection(stringResource(R.string.vaults_sort_by))
    for (field in VaultSortField.entries) {
        val label = stringResource(
            when (field) {
                VaultSortField.Name -> R.string.vaults_sort_name
                VaultSortField.Updated -> R.string.vaults_sort_modified
                VaultSortField.Size -> R.string.vaults_sort_size
            },
        )
        HappyMenuItem(
            label,
            onClick = { close(); onSort(sort.picking(field)) },
            selected = sort.field == field,
            trailing = if (sort.field == field) ({ MenuGlyph(if (sort.descending) Ionicon.ArrowDown else Ionicon.ArrowUp) }) else null,
        )
    }
}

@Composable
internal fun MenuGlyph(icon: Ionicon) = Icon(icon, 20.dp, HappyTheme.colors.text)

/** What can be done to [entry], as menu rows: open in another app, share, save, history, rename, move, a new version, delete; in the Trash, restore. */
@Composable
internal fun ColumnScope.VaultItemMenuItems(entry: VaultItem, actions: VaultActions, close: () -> Unit, inTrash: Boolean = false) {
    if (inTrash || entry.deletedAt != null) {
        if (entry.deletedAt != null) HappyMenuItem(stringResource(R.string.vaults_restore), onClick = { close(); actions.restore(entry) }, leading = { MenuGlyph(Ionicon.ArrowUndoOutline) })
        HappyMenuItem(stringResource(R.string.vaults_save_to_device), onClick = { close(); actions.save(entry) }, leading = { MenuGlyph(Ionicon.DownloadOutline) })
        if (!entry.isFolder) HappyMenuItem(stringResource(R.string.vaults_history), onClick = { close(); actions.history(entry) }, leading = { MenuGlyph(Ionicon.TimeOutline) })
        return
    }
    if (entry.isFile) HappyMenuItem(stringResource(R.string.vaults_open_in), onClick = { close(); actions.openElsewhere(entry) }, leading = { MenuGlyph(Ionicon.OpenOutline) })
    HappyMenuItem(stringResource(R.string.vaults_share), onClick = { close(); actions.share(entry) }, leading = { MenuGlyph(Ionicon.ShareOutline) })
    HappyMenuItem(stringResource(R.string.vaults_save_to_device), onClick = { close(); actions.save(entry) }, leading = { MenuGlyph(Ionicon.DownloadOutline) })
    HappyMenuItem(stringResource(R.string.vaults_history), onClick = { close(); actions.history(entry) }, leading = { MenuGlyph(Ionicon.TimeOutline) })
    HappyMenuItem(stringResource(R.string.vaults_rename), onClick = { close(); actions.rename(entry) }, leading = { MenuGlyph(Ionicon.CreateOutline) })
    HappyMenuItem(stringResource(R.string.vaults_move), onClick = { close(); actions.move(entry) }, leading = { MenuGlyph(Ionicon.MoveOutline) })
    if (!entry.isFolder) HappyMenuItem(stringResource(R.string.vaults_upload_new_version), onClick = { close(); actions.replace(entry) }, leading = { MenuGlyph(Ionicon.CloudUploadOutline) })
    HappyMenuItem(stringResource(R.string.vaults_delete), onClick = { close(); actions.delete(entry) }, leading = { MenuGlyph(Ionicon.TrashOutline) }, destructive = true)
}

/** The whole vault as an entry for a download: [VaultActions.save] writes it as one zip. */
internal object VaultRootItem {
    /** Its ID is empty, which [com.slopus.happy.vaults.VaultDownloads] reads as the vault's own zip. */
    fun of(surfaceId: String, name: String) = VaultItem(id = "", surfaceId = surfaceId, name = name.ifEmpty { "Vault" }, kind = VaultItem.FOLDER, version = "")
}
