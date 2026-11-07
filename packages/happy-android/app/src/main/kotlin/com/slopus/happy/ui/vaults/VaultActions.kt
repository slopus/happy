package com.slopus.happy.ui.vaults

import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.content.res.Resources
import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContract
import androidx.activity.result.contract.ActivityResultContracts
import androidx.annotation.StringRes
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import com.slopus.happy.R
import com.slopus.happy.agent.AgentApiException
import com.slopus.happy.agent.AgentClient
import com.slopus.happy.agent.AgentSession
import com.slopus.happy.agent.VaultAccess
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.slopus.happy.conversation.Conversation
import com.slopus.happy.conversation.MediaFiles
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.HappyAlert
import com.slopus.happy.ui.components.Prompt
import com.slopus.happy.ui.components.PromptModal
import com.slopus.happy.ui.components.TrackOverlay
import com.slopus.happy.ui.conversation.problemText
import com.slopus.happy.vaults.VaultClient
import com.slopus.happy.vaults.VaultDownloads
import com.slopus.happy.vaults.VaultItem
import com.slopus.happy.vaults.VaultNames
import com.slopus.happy.vaults.VaultUploadSource
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

object VaultActionTags {
    const val TRANSFER = "vault.transfer"
    const val TRANSFER_CANCEL = "vault.transfer.cancel"
}

/**
 * Everything a person can do to a vault's entries, from any of its screens
 * (a folder's rows and bar, a file's bar, the Trash): each asks
 * what it needs (a name, a folder, a confirmation, a place on the phone),
 * changes the vault and hands the entry the daemon answered with to the
 * vault's folders ([com.slopus.happy.vaults.Vaults.known]), so they show
 * it before its event. A change made meanwhile elsewhere (a stale
 * `If-Match`) is tried once more against the entry as it now is. Draw its
 * dialogs with [VaultActionsHost].
 */
@Stable
class VaultActions internal constructor(
    val session: AgentSession,
    val surfaceId: String,
    private val scope: CoroutineScope,
    private val context: Context,
    private val resources: Resources,
    private val open: (Any) -> Unit,
) {
    /** A pending dialog's parent folder: null is the vault's root. */
    internal class Folder(val id: String?)

    internal class Transfer(val name: String, val sent: Long, val total: Long?, val job: Job?)

    internal var renaming by mutableStateOf<VaultItem?>(null)
    internal var moving by mutableStateOf<VaultItem?>(null)
    internal var deleting by mutableStateOf<VaultItem?>(null)
    internal var creating by mutableStateOf<Folder?>(null)
    /** A failure's dialog: [title] over [message]. A name the vault keeps for apps is a rule, not something broken. */
    internal class Failure(val message: String, @StringRes val title: Int = R.string.vaults_failed)

    internal var failure by mutableStateOf<Failure?>(null)

    /** The person may change this vault: it lets them write, and their role writes content. */
    internal var writable by mutableStateOf(false)

    /** This vault is the team's Policy vault, whose places stay put ([PolicyPlaces]). */
    internal var policy by mutableStateOf(false)

    /** The folder whose entries this screen shows: its name, and whether it is at the root. Null at the root. */
    internal var within by mutableStateOf<Pair<String, Boolean>?>(null)

    /** Whether [entry] may be renamed, moved or deleted. */
    fun canChange(entry: VaultItem): Boolean =
        writable && !(policy && PolicyPlaces.fixed(entry, within?.first, within?.second == true))
    internal var transfer by mutableStateOf<Transfer?>(null)
    internal var pickFiles: (String?) -> Unit = {}
    internal var pickMedia: (String?) -> Unit = {}
    internal var pickReplacement: (VaultItem) -> Unit = {}
    internal var pickPlace: (VaultItem, Int?) -> Unit = { _, _ -> }

    val routes: VaultClient get() = session.vaults.routes

    fun rename(entry: VaultItem) { renaming = entry }
    fun move(entry: VaultItem) { moving = entry }
    fun delete(entry: VaultItem) { deleting = entry }
    fun newFolder(parentId: String?) { creating = Folder(parentId) }
    fun uploadFiles(parentId: String?) = pickFiles(parentId)
    fun uploadMedia(parentId: String?) = pickMedia(parentId)
    fun replace(entry: VaultItem) = pickReplacement(entry)
    fun history(entry: VaultItem) = open(VaultHistoryRoute(session.connectionId, surfaceId, entry.id, entry.isFolder, entry.shownName))

    /** Saves [entry] (a file's [version], null the latest) where the person picks, through the system's Save to. */
    fun save(entry: VaultItem, version: Int? = null) = pickPlace(entry, version)

    fun restore(entry: VaultItem) = change(entry) { routes.restore(it) }

    /** Makes [version]'s content the newest version again; history only grows. One `operationId` for the tap, kept on its retry. */
    fun restoreVersion(entry: VaultItem, version: Int) {
        val operationId = AgentClient.newId()
        change(entry) { routes.newVersion(it, fromVersion = version, operationId = operationId).first }
    }

    internal fun created(parentId: String?, name: String) {
        if (VaultNames.isArtifact(name.trim())) {
            failure = Failure(resources.getString(R.string.vaults_name_reserved), R.string.vaults_name_refused)
            return
        }
        scope.launch {
            try {
                session.vaults.known(routes.createFolder(surfaceId, parentId, name.trim()))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                failure = Failure(describe(e, name.trim()))
            }
        }
    }

    internal fun renamed(entry: VaultItem, name: String) {
        val next = newName(entry, name) ?: run {
            failure = Failure(resources.getString(R.string.vaults_name_reserved), R.string.vaults_name_refused)
            return
        }
        if (next == entry.name) return
        change(entry, next) { routes.update(it, name = next) }
    }

    internal fun moved(entry: VaultItem, parentId: String?) {
        if (parentId == entry.parentId) return
        change(entry) { routes.update(it, move = true, parentId = parentId) }
    }

    internal fun deleted(entry: VaultItem) = change(entry) { routes.delete(it) }

    /** [request] against [entry], once more against the current entry after a stale `If-Match`. */
    private fun change(entry: VaultItem, name: String = entry.name, request: suspend (VaultItem) -> VaultItem) {
        scope.launch {
            try {
                val answer = try {
                    request(entry)
                } catch (e: AgentApiException) {
                    if (e.status != 409 || e.code == "name_taken") throw e
                    val current = VaultClient.conflictItem(e) ?: throw e
                    if (current.version == entry.version) throw e
                    session.vaults.known(current)
                    request(current)
                }
                session.vaults.known(answer)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                failure = Failure(describe(e, name))
            }
        }
    }

    private fun describe(e: Exception, name: String): String = when {
        e is AgentApiException && e.code == "name_taken" -> resources.getString(R.string.vaults_name_taken, VaultNames.shown(name))
        e is AgentApiException && e.status == 409 -> resources.getString(R.string.vaults_changed_elsewhere)
        else -> resources.problemText(Conversation.describe(e))
    }

    /** Shares [entry] (a file's [version]) through the share sheet: read to the phone first, a folder or an artifact as a zip. */
    fun share(entry: VaultItem, version: Int? = null) {
        val name = VaultDownloads.name(entry)
        val job = scope.launch {
            try {
                val file = withContext(Dispatchers.IO) {
                    val directory = File(File(context.cacheDir, MediaFiles.DIRECTORY), "vault-${entry.id}-${version ?: entry.latestVersion ?: 0}")
                    directory.mkdirs()
                    val target = File(directory, MediaFiles.safeName(name, VaultDownloads.mediaType(entry)))
                    val partial = File(directory, target.name + ".part")
                    partial.outputStream().use { out ->
                        VaultDownloads.write(routes, entry, version ?: entry.latestVersion, sizeOf(entry, version), out) { sent, total ->
                            transfer = Transfer(name, sent, total, transfer?.job)
                        }
                    }
                    if (!partial.renameTo(target)) throw java.io.IOException("Couldn't keep the file")
                    target
                }
                val uri = FileProvider.getUriForFile(context, "${context.packageName}.conversation.media", file)
                transfer = null
                context.startActivity(Intent.createChooser(vaultShare(uri, entry), entry.shownName).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                failure = Failure(describe(e, name))
            } finally {
                transfer = null
            }
        }
        transfer = Transfer(name, 0, sizeOf(entry, version), job)
    }

    /** Opens [entry] (a file's [version]) in whatever app on the phone reads it. */
    fun openElsewhere(entry: VaultItem, version: Int? = null) {
        val name = VaultDownloads.name(entry)
        val job = scope.launch {
            try {
                val file = withContext(Dispatchers.IO) {
                    val directory = File(File(context.cacheDir, MediaFiles.DIRECTORY), "vault-${entry.id}-${version ?: entry.latestVersion ?: 0}")
                    directory.mkdirs()
                    val target = File(directory, MediaFiles.safeName(name, VaultDownloads.mediaType(entry)))
                    target.outputStream().use { out ->
                        VaultDownloads.write(routes, entry, version ?: entry.latestVersion, sizeOf(entry, version), out) { sent, total ->
                            transfer = Transfer(name, sent, total, transfer?.job)
                        }
                    }
                    target
                }
                val uri = FileProvider.getUriForFile(context, "${context.packageName}.conversation.media", file)
                transfer = null
                try {
                    context.startActivity(
                        Intent(Intent.ACTION_VIEW).setDataAndType(uri, VaultDownloads.mediaType(entry))
                            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK),
                    )
                } catch (_: ActivityNotFoundException) {
                    failure = Failure(resources.getString(R.string.vaults_no_app))
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                failure = Failure(describe(e, name))
            } finally {
                transfer = null
            }
        }
        transfer = Transfer(name, 0, sizeOf(entry, version), job)
    }

    internal fun placed(entry: VaultItem, version: Int?, uri: Uri?) {
        uri ?: return
        val name = VaultDownloads.name(entry)
        val job = scope.launch {
            try {
                withContext(Dispatchers.IO) {
                    val out = context.contentResolver.openOutputStream(uri, "wt") ?: throw java.io.IOException("No stream")
                    out.use {
                        VaultDownloads.write(routes, entry, version ?: entry.latestVersion, sizeOf(entry, version), it) { sent, total ->
                            transfer = Transfer(name, sent, total, transfer?.job)
                        }
                    }
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                failure = Failure(describe(e, name))
            } finally {
                transfer = null
            }
        }
        transfer = Transfer(name, 0, sizeOf(entry, version), job)
    }

    /** A known version's size: the latest's from the entry; an older one's isn't known until read. */
    private fun sizeOf(entry: VaultItem, version: Int?): Long? = if (version == null || version == entry.latestVersion) entry.size else null

    internal fun upload(parentId: String?, uris: List<Uri>) {
        if (uris.isEmpty()) return
        scope.launch {
            for (uri in uris) {
                val source = try {
                    withContext(Dispatchers.IO) { UriSource.of(context, uri) }
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    failure = Failure(describe(e, ""))
                    continue
                }
                session.vaults.uploads.add(surfaceId, parentId, source)
            }
        }
    }

    internal fun replaced(entry: VaultItem, uri: Uri?) {
        uri ?: return
        scope.launch {
            try {
                session.vaults.uploads.replace(entry, withContext(Dispatchers.IO) { UriSource.of(context, uri) })
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                failure = Failure(describe(e, entry.name))
            }
        }
    }
}

/**
 * [entry]'s file at [uri] for the share sheet. The file keeps its own name
 * (an app's `.artifact`), while the title the sheet and the receiving app
 * show is the name as people know it, as iOS's link metadata does.
 */
internal fun vaultShare(uri: Uri, entry: VaultItem): Intent = Intent(Intent.ACTION_SEND)
    .setType(VaultDownloads.mediaType(entry))
    .putExtra(Intent.EXTRA_STREAM, uri)
    .putExtra(Intent.EXTRA_TITLE, entry.shownName)
    .apply { clipData = ClipData(entry.shownName, arrayOf(VaultDownloads.mediaType(entry)), ClipData.Item(uri)) }
    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)

/**
 * [typed] as [entry]'s new name. An app's is typed without its ".artifact",
 * which it keeps unseen; a folder's or plain file's can't take one (null).
 */
internal fun newName(entry: VaultItem, typed: String): String? {
    val name = typed.trim()
    return when {
        entry.isArtifact -> if (name == entry.shownName) entry.name else VaultNames.appName(name)
        VaultNames.isArtifact(name) -> null
        else -> name
    }
}

/**
 * A picked document as an upload's bytes: its name and size as its
 * provider says them. One whose size isn't said is copied into the cache
 * first, since an upload states its size before its bytes.
 */
internal class UriSource private constructor(private val context: Context, private val uri: Uri, override val name: String, override val size: Long, private val copy: File?) : VaultUploadSource {

    override fun open(): java.io.InputStream = copy?.inputStream() ?: context.contentResolver.openInputStream(uri) ?: throw java.io.IOException("Unreadable")

    companion object {
        fun of(context: Context, uri: Uri): UriSource {
            // Kept readable for a retry later in the run.
            runCatching { context.contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) }
            var name: String? = null
            var size: Long? = null
            context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) {
                    name = cursor.getString(0)
                    if (!cursor.isNull(1)) size = cursor.getLong(1).takeIf { it >= 0 }
                }
            }
            val leaf = name?.substringAfterLast('/')?.takeIf { it.isNotBlank() } ?: uri.lastPathSegment?.substringAfterLast('/') ?: "file"
            val known = size
            if (known != null) return UriSource(context, uri, leaf, known, null)
            val directory = File(context.cacheDir, "vault-uploads").apply { mkdirs() }
            val copy = File.createTempFile("upload", null, directory)
            context.contentResolver.openInputStream(uri)?.use { input -> copy.outputStream().use { input.copyTo(it) } } ?: throw java.io.IOException("Unreadable")
            return UriSource(context, uri, leaf, copy.length(), copy)
        }
    }
}

/** The system's Save to for one file whose name and type are chosen when it opens. */
private class SaveDocument : ActivityResultContract<Pair<String, String>, Uri?>() {
    override fun createIntent(context: Context, input: Pair<String, String>): Intent =
        Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(input.second).putExtra(Intent.EXTRA_TITLE, input.first)

    override fun parseResult(resultCode: Int, intent: Intent?): Uri? = intent?.data.takeIf { resultCode == android.app.Activity.RESULT_OK }
}

@Composable
fun rememberVaultActions(session: AgentSession, surfaceId: String, open: (Any) -> Unit): VaultActions {
    val context = LocalContext.current
    val resources = LocalResources.current
    val scope = rememberCoroutineScope()
    val actions = remember(session, surfaceId) { VaultActions(session, surfaceId, scope, context, resources, open) }
    val permissions by session.permissions.collectAsStateWithLifecycle()
    val surface by remember(session, surfaceId) { session.surface(surfaceId) }.collectAsStateWithLifecycle(session.surfaces.value[surfaceId])
    actions.writable = permissions.canWrite && surface?.access == VaultAccess.Write
    actions.policy = surface?.policyVault == true
    var uploadInto by remember { mutableStateOf<VaultActions.Folder?>(null) }
    var replacing by remember { mutableStateOf<VaultItem?>(null) }
    var placing by remember { mutableStateOf<Pair<VaultItem, Int?>?>(null) }
    val files = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        uploadInto?.let { actions.upload(it.id, uris) }
        uploadInto = null
    }
    val media = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia()) { uris ->
        uploadInto?.let { actions.upload(it.id, uris) }
        uploadInto = null
    }
    val replacement = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        replacing?.let { actions.replaced(it, uri) }
        replacing = null
    }
    val place = rememberLauncherForActivityResult(SaveDocument()) { uri ->
        placing?.let { (entry, version) -> actions.placed(entry, version, uri) }
        placing = null
    }
    val unavailable = stringResource(R.string.vaults_no_app)
    fun launching(block: () -> Unit) = try {
        block()
    } catch (_: ActivityNotFoundException) {
        actions.failure = VaultActions.Failure(unavailable)
    }
    actions.pickFiles = { parentId -> uploadInto = VaultActions.Folder(parentId); launching { files.launch(arrayOf("*/*")) } }
    actions.pickMedia = { parentId ->
        uploadInto = VaultActions.Folder(parentId)
        launching { media.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageAndVideo)) }
    }
    actions.pickReplacement = { entry ->
        replacing = entry
        launching { replacement.launch(arrayOf("*/*")) }
    }
    actions.pickPlace = { entry, version -> placing = entry to version; launching { place.launch(VaultDownloads.name(entry) to VaultDownloads.mediaType(entry)) } }
    return actions
}

/** The dialogs [actions] asks with: names, the folder picker, confirmations, a transfer's progress, and failures. */
@Composable
fun VaultActionsHost(actions: VaultActions) {
    actions.creating?.let { folder ->
        PromptModal(
            Prompt(
                title = stringResource(R.string.vaults_new_folder),
                placeholder = stringResource(R.string.vaults_name),
                defaultValue = stringResource(R.string.vaults_untitled_folder),
                confirmText = stringResource(R.string.vaults_create),
                allowBlank = false,
            ) { name -> if (name != null) actions.created(folder.id, name) },
            onDismiss = { actions.creating = null },
        )
    }
    actions.renaming?.let { entry ->
        PromptModal(
            Prompt(
                title = stringResource(R.string.vaults_rename),
                defaultValue = entry.shownName,
                confirmText = stringResource(R.string.vaults_rename),
                allowBlank = false,
            ) { name -> if (name != null) actions.renamed(entry, name) },
            onDismiss = { actions.renaming = null },
        )
    }
    actions.moving?.let { entry ->
        VaultFolderPicker(actions.session, actions.surfaceId, entry, onDismiss = { actions.moving = null }) { parentId ->
            actions.moving = null
            actions.moved(entry, parentId)
        }
    }
    actions.deleting?.let { entry ->
        HappyAlert(
            Alert(
                title = stringResource(R.string.vaults_delete_title, entry.shownName),
                message = stringResource(if (entry.isFolder) R.string.vaults_delete_folder_message else R.string.vaults_delete_message),
                buttons = listOf(
                    AlertButton(stringResource(R.string.common_cancel)),
                    AlertButton(stringResource(R.string.vaults_move_to_trash), destructive = true) { actions.deleted(entry) },
                ),
            ),
            onDismiss = { actions.deleting = null },
        )
    }
    actions.transfer?.let { transfer ->
        TrackOverlay(true) { transfer.job?.cancel() }
        AlertDialog(
            onDismissRequest = {},
            modifier = Modifier.testTag(VaultActionTags.TRANSFER),
            title = { Text(stringResource(R.string.vaults_downloading, VaultNames.shown(transfer.name))) },
            text = {
                Column {
                    val total = transfer.total
                    if (total != null && total > 0) LinearProgressIndicator(progress = { (transfer.sent.toFloat() / total).coerceIn(0f, 1f) }, modifier = Modifier.fillMaxWidth())
                    else LinearProgressIndicator(Modifier.fillMaxWidth())
                    Text(vaultBytes(transfer.sent, total), modifier = Modifier.padding(top = 12.dp))
                }
            },
            confirmButton = {},
            dismissButton = {
                TextButton(onClick = { transfer.job?.cancel() }, modifier = Modifier.testTag(VaultActionTags.TRANSFER_CANCEL)) {
                    Text(stringResource(R.string.common_cancel))
                }
            },
        )
    }
    actions.failure?.let { failure ->
        HappyAlert(
            Alert(stringResource(failure.title), failure.message.ifEmpty { null }, listOf(AlertButton(stringResource(R.string.common_ok)))),
            onDismiss = { actions.failure = null },
        )
    }
}

/**
 * The Policy vault's places that stay as they are: its `Global` and
 * `Security` folders at the root, and the one document each keeps, the
 * team's instructions and security rules. Known by name and parent: the
 * server gives them no marks of their own.
 */
internal object PolicyPlaces {
    private val documents = mapOf("Global" to "AGENTS.md", "Security" to "SECURITY.md")

    /** Whether [entry] is one, in the folder named [parent] ([parentAtRoot] whether that folder is at the root). */
    fun fixed(entry: VaultItem, parent: String?, parentAtRoot: Boolean): Boolean = when {
        entry.parentId == null -> entry.isFolder && entry.name in documents
        else -> entry.isFile && parentAtRoot && documents[parent] == entry.name
    }
}
