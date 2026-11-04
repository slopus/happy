package com.slopus.happy.ui.attach

import androidx.compose.runtime.DisposableEffect
import android.content.res.Configuration
import androidx.compose.ui.platform.LocalConfiguration
import android.app.Activity
import android.content.ClipboardManager
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.media.MediaDataSource
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import android.provider.Settings
import android.view.WindowManager
import androidx.activity.compose.PredictiveBackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.platform.LocalView
import com.slopus.happy.ui.components.PageDialog as Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.DialogWindowProvider
import com.slopus.happy.R
import com.slopus.happy.attachments.AttachAccepts
import com.slopus.happy.attachments.AttachTabKind
import com.slopus.happy.attachments.AttachmentPreview
import com.slopus.happy.attachments.AttachmentStaging
import com.slopus.happy.attachments.GalleryAccess
import com.slopus.happy.attachments.GalleryItem
import com.slopus.happy.attachments.MediaGallery
import com.slopus.happy.attachments.PickedKind
import com.slopus.happy.attachments.PendingPicture
import com.slopus.happy.attachments.PickedMedia
import com.slopus.happy.attachments.RecentFile
import com.slopus.happy.attachments.RecentFiles
import com.slopus.happy.attachments.Staged
import com.slopus.happy.attachments.StagingProblem
import com.slopus.happy.conversation.ViewerItem
import com.slopus.happy.ui.attachments.attachmentCacheDir
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.HappyAlert
import com.slopus.happy.ui.components.rememberReduceMotion
import com.slopus.happy.ui.components.TrackOverlay
import com.slopus.happy.ui.conversation.PictureViewer
import com.slopus.happy.ui.conversation.ViewerSource
import com.slopus.happy.ui.files.WorkspaceFilePicker
import com.slopus.happy.ui.files.WorkspaceSource
import com.slopus.happy.ui.files.withWorkspacePath
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.FileInputStream
import java.io.IOException
import java.nio.ByteBuffer

/**
 * The attachment sheet over the whole window while [open]: Telegram's
 * gallery of recent photos and videos (asking for access the first time)
 * and its File tab, as [accepts] allows. What is picked goes with the
 * [caption] (the composer's words, edited here too) once Send is pressed:
 * each pick is copied into the app's cache first ([AttachmentStaging]),
 * then [onSend] has them. Room is [room] picks. [onClosed] runs once the
 * sheet has gone, after its own close. On a phone held upright it grows
 * out of [button] and goes back into it ([AttachMorph]). With a [workspace]
 * the File tab can name one of its files instead: the picked path goes
 * into the caption as `./path` and nothing is uploaded. With
 * [onSendPending], gallery photos don't wait to be read: the sheet goes at
 * once and each goes as its thumbnail, read after ([PendingPicture]).
 */
@Composable
fun AttachSheet(
    open: Boolean,
    accepts: AttachAccepts,
    caption: String,
    onCaptionChange: (String) -> Unit,
    onSend: (List<AttachmentPreview>) -> Unit,
    onClosed: () -> Unit,
    room: Int = accepts.maxItems,
    button: AttachButton? = null,
    workspace: WorkspaceSource? = null,
    onSendPending: ((List<AttachmentPreview>, List<PendingPicture>) -> Unit)? = null,
    onPhoto: ((AttachmentPreview) -> Unit)? = null,
) {
    if (!open) return
    val tabs = accepts.tabs
    if (tabs.isEmpty()) {
        SideEffect(onClosed)
        return
    }
    val context = LocalContext.current
    val resources = LocalResources.current
    val scope = rememberCoroutineScope()
    val reduceMotion = rememberReduceMotion()
    val haptics = LocalHapticFeedback.current
    val motion = remember { AttachSheetMotion() }
    val camera = remember { AttachCameraState() }.takeIf { accepts.photos && onPhoto != null }
    val selection = remember { AttachSelection(room.coerceAtLeast(0)) }
    val closed by rememberUpdatedState(onClosed)
    val send by rememberUpdatedState(onSend)
    val sendPending by rememberUpdatedState(onSendPending)
    var tab by remember { mutableStateOf(tabs.first()) }
    var alert by remember { mutableStateOf<Alert?>(null) }
    var sending by remember { mutableStateOf(false) }
    var viewing by remember { mutableStateOf<Int?>(null) }
    var naming by remember { mutableStateOf(false) }
    val closeExtra = with(LocalDensity.current) { AttachSpec.closeExtra.toPx() }
    val configuration = LocalConfiguration.current
    val grows = configuration.screenWidthDp < AttachMorph.MAX_WIDTH_DP && configuration.orientation == Configuration.ORIENTATION_PORTRAIT
    DisposableEffect(motion) { onDispose { motion.giveBack() } }

    fun close() {
        if (motion.closing) return
        scope.launch {
            motion.close(closeExtra, reduceMotion)
            motion.giveBack()
            closed()
        }
    }
    // A link must close the whole attachment flow, even while its camera is on top.
    TrackOverlay(open) { close() }

    fun say(title: Int, message: String) {
        alert = Alert(resources.getString(title), message, listOf(AlertButton(resources.getString(R.string.common_ok))))
    }

    fun toggle(item: PickedMedia) {
        if (selection.toggle(item)) {
            haptics.performHapticFeedback(HapticFeedbackType.ContextClick)
        } else {
            say(R.string.image_upload_limit_title, resources.getString(R.string.attach_limit_message, selection.maxItems))
        }
    }

    // The gallery, as far as access reaches; read again whenever it changes.
    val gallery = remember { MediaGallery(context.contentResolver) }
    var access by remember { mutableStateOf(GalleryAccess.of(context)) }
    var blocked by remember { mutableStateOf(false) }
    var items by remember { mutableStateOf<List<GalleryItem>>(emptyList()) }
    var loaded by remember { mutableStateOf(false) }
    val wantsGallery = AttachTabKind.Gallery in tabs
    LaunchedEffect(access, wantsGallery) {
        if (!wantsGallery || access == GalleryAccess.None) return@LaunchedEffect
        suspend fun load() {
            items = withContext(Dispatchers.IO) { gallery.load(videos = accepts.videos, photos = accepts.photos) }
            loaded = true
        }
        load()
        gallery.changes().collectLatest {
            kotlinx.coroutines.delay(300)
            load()
        }
    }
    val permissions = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        access = GalleryAccess.of(context)
        if (access == GalleryAccess.None) {
            val activity = context.findActivity()
            blocked = activity != null && GalleryAccess.permissions().none { permission -> activity.shouldShowRequestPermissionRationale(permission) }
        }
    }
    val settings = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) {
        access = GalleryAccess.of(context)
        if (access != GalleryAccess.None) blocked = false
    }
    fun allow() {
        if (blocked) {
            settings.launch(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null)))
        } else {
            permissions.launch(GalleryAccess.permissions())
        }
    }
    // Telegram asks as the sheet opens.
    LaunchedEffect(Unit) {
        if (wantsGallery && access == GalleryAccess.None) permissions.launch(GalleryAccess.permissions())
    }

    // The File tab: what was sent from here before, and what was just picked, first.
    val picked = remember { mutableStateListOf<RecentFile>() }
    var sent by remember { mutableStateOf<List<RecentFile>>(emptyList()) }
    LaunchedEffect(Unit) { if (accepts.files) sent = withContext(Dispatchers.IO) { RecentFiles(context).list() } }
    fun offer(files: List<PickedMedia>) {
        for (file in files) {
            when {
                file.kind == PickedKind.File && !accepts.allowsType(file.mimeType) ->
                    say(R.string.attach_unsupported_title, resources.getString(R.string.attach_unsupported_message, file.name))
                !accepts.fits(file.size) ->
                    say(R.string.image_upload_file_too_large_title, resources.getString(R.string.image_upload_file_too_large_message, file.name, (accepts.maxFileBytes / 1024 / 1024).toInt()))
                else -> {
                    picked.removeAll { it.uri == file.uri }
                    picked.add(0, RecentFile(file.uri, file.name, file.mimeType, file.size, System.currentTimeMillis()))
                    if (!selection.pick(file)) {
                        say(R.string.image_upload_limit_title, resources.getString(R.string.attach_limit_message, selection.maxItems))
                        return
                    }
                }
            }
        }
    }
    val browse = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        scope.launch { offer(withContext(Dispatchers.IO) { uris.map { describe(context, it, PickedKind.File) } }) }
    }
    val galleryFiles = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(maxOf(2, accepts.maxItems))) { uris ->
        val kind = if (accepts.files) PickedKind.File else PickedKind.Photo
        scope.launch { offer(withContext(Dispatchers.IO) { uris.map { describe(context, it, kind) } }) }
    }
    fun paste() {
        val uri = clipboardImage(context)
        if (uri == null) {
            say(R.string.image_upload_nothing_to_paste_title, resources.getString(R.string.image_upload_nothing_to_paste_message))
            return
        }
        scope.launch {
            val item = withContext(Dispatchers.IO) { describe(context, uri, if (accepts.files) PickedKind.File else PickedKind.Photo) }
            offer(listOf(item.copy(name = item.name.takeIf { it.contains('.') } ?: "pasted_${System.currentTimeMillis()}.png")))
        }
    }

    fun sendPicks() {
        if (sending || selection.count == 0) return
        sending = true
        val picks = selection.items.toList()
        val later = sendPending
        val app = context.applicationContext
        val staging = AttachmentStaging(attachmentCacheDir(app)) { pick ->
            app.contentResolver.openInputStream(Uri.parse(pick.uri)) ?: throw IOException("Cannot open ${pick.name}")
        }
        scope.launch {
            try {
                // A gallery photo goes as its thumbnail, read once the sheet has gone (iOS b03dd48cc).
                val photos = if (later == null) emptyList() else picks.filter { it.kind == PickedKind.Photo }
                val thumbnails = withContext(Dispatchers.IO) { photos.map { async { galleryThumbnail(app.contentResolver, it.uri) } }.awaitAll() }
                val pending = photos.zip(thumbnails).mapNotNull { (pick, thumbnail) ->
                    thumbnail?.let {
                        pick to PendingPicture(it) {
                            withContext(Dispatchers.IO) { staging.stage(listOf(pick), accepts) }.attachments.singleOrNull() ?: throw IOException("Cannot read ${pick.name}")
                        }
                    }
                }
                val now = picks.filter { pick -> pending.none { it.first == pick } }
                val staged = if (now.isEmpty()) Staged(emptyList(), emptyList()) else withContext(Dispatchers.IO) { staging.stage(now, accepts) }
                staged.problems.firstOrNull()?.let { problem ->
                    when (problem) {
                        is StagingProblem.TooLarge -> say(R.string.image_upload_file_too_large_title, resources.getString(R.string.image_upload_file_too_large_message, problem.name, problem.maxMb))
                        is StagingProblem.Unreadable -> say(R.string.image_upload_upload_failed_title, resources.getString(R.string.attach_unreadable_message, problem.name))
                    }
                }
                if (staged.attachments.isEmpty() && pending.isEmpty()) return@launch
                val files = picks.filter { it.kind == PickedKind.File && it.uri.startsWith("content:") }
                if (files.isNotEmpty() && accepts.files) withContext(Dispatchers.IO) { RecentFiles(context).remember(files) }
                if (later != null && pending.isNotEmpty()) later(staged.attachments, pending.map { it.second }) else send(staged.attachments)
                if (staged.problems.isEmpty()) close()
                else selection.clear()
            } finally {
                sending = false
            }
        }
    }

    Dialog(
        onDismissRequest = { if (camera?.full == true) camera.back() else close() },
        properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false),
    ) {
        // Our own 0.2 scrim fades with the sheet; the window's dim would sit still behind it.
        // Resized for the keyboard, so the caption bar rides above it.
        val window = (LocalView.current.parent as? DialogWindowProvider)?.window
        SideEffect {
            window?.setDimAmount(0f)
            @Suppress("DEPRECATION")
            window?.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
        }
        LaunchedEffect(Unit) { motion.open(reduceMotion, button.takeIf { grows }) }
        val dismissAt = context.resources.displayMetrics.xdpi / 2.54f * AttachSpec.DISMISS_CM
        PredictiveBackHandler(enabled = !motion.closing && camera?.full != true) { progress ->
            try {
                progress.collect { motion.drag = it.progress * dismissAt * 2 }
                close()
            } catch (e: CancellationException) {
                motion.springBack(dismissAt * 2)
                throw e
            }
        }
        AttachSheetLayout(
            tabs = tabs,
            tab = tab,
            onTab = { tab = it },
            gallery = GalleryContent(access, items, loaded, blocked),
            sources = FileSources(browse = accepts.files, gallery = accepts.files || accepts.photos, paste = accepts.photos || accepts.files, workspace = workspace != null),
            recent = (picked + sent.filter { old -> picked.none { it.uri == old.uri } }),
            selection = selection,
            caption = caption,
            onCaptionChange = onCaptionChange,
            motion = motion,
            onClose = ::close,
            onSend = ::sendPicks,
            onToggleGallery = { toggle(it.picked()) },
            onOpenGallery = { item -> viewing = items.indexOf(item).takeIf { it >= 0 } },
            onToggleFile = { toggle(it.picked()) },
            onAllow = ::allow,
            onManage = { permissions.launch(GalleryAccess.permissions()) },
            onBrowse = { browse.launch(accepts.fileTypes?.toTypedArray() ?: arrayOf("*/*")) },
            onFilesGallery = {
                val type = if (accepts.files || accepts.videos) ActivityResultContracts.PickVisualMedia.ImageAndVideo else ActivityResultContracts.PickVisualMedia.ImageOnly
                galleryFiles.launch(PickVisualMediaRequest.Builder().setMediaType(type).build())
            },
            onPaste = ::paste,
            onWorkspace = { naming = true },
            sending = sending,
            camera = camera,
        )
        if (camera != null && onPhoto != null) AttachCamera(
            state = camera, visible = tab == AttachTabKind.Gallery && viewing == null && !naming && !motion.closing,
            maxBytes = accepts.maxFileBytes,
            hasRoom = {
                if (room > 0) true else {
                    say(R.string.image_upload_limit_title, resources.getString(R.string.attach_limit_message, accepts.maxItems))
                    false
                }
            },
            onPhoto = onPhoto,
            onFinished = { motion.giveBack(); closed() },
        )
        viewing?.let { index ->
            val shown = remember(items) { items.map { ViewerItem(it.uri, it.name, it.isVideo, it.width.toFloat().takeIf { w -> w > 0 }, it.height.toFloat().takeIf { h -> h > 0 }) } }
            PictureViewer(shown, index, remember(context) { GallerySource(context) }, onClose = { viewing = null })
        }
        if (naming && workspace != null) {
            WorkspaceFilePicker(
                workspace,
                onPick = { path ->
                    naming = false
                    onCaptionChange(withWorkspacePath(caption, path))
                    // Picks waiting keep the sheet, the path in their caption; alone, it goes with the words.
                    if (selection.count == 0) close()
                },
                onClose = { naming = false },
            )
        }
        alert?.let { HappyAlert(it, onDismiss = { alert = null }) }
    }
}

/** The preview's pictures and recordings: read straight from the gallery. */
private class GallerySource(private val context: Context) : ViewerSource {
    override suspend fun bytes(key: String): ByteArray? = withContext(Dispatchers.IO) {
        context.contentResolver.openInputStream(Uri.parse(key))?.use { it.readBytes() }
    }

    override fun video(key: String): MediaDataSource? = try {
        context.contentResolver.openFileDescriptor(Uri.parse(key), "r")?.let(::FileSource)
    } catch (_: Exception) {
        null
    }
}

/** A recording the player reads by position, from its file descriptor. */
private class FileSource(private val descriptor: ParcelFileDescriptor) : MediaDataSource() {
    private val channel = FileInputStream(descriptor.fileDescriptor).channel

    override fun readAt(position: Long, buffer: ByteArray, offset: Int, size: Int): Int {
        if (size == 0) return 0
        val read = channel.read(ByteBuffer.wrap(buffer, offset, size), position)
        return if (read <= 0) -1 else read
    }

    override fun getSize(): Long = descriptor.statSize

    override fun close() {
        runCatching { channel.close() }
        runCatching { descriptor.close() }
    }
}

/** A picked URI's name, type and size, as the system says them. */
private fun describe(context: Context, uri: Uri, kind: PickedKind): PickedMedia {
    var name: String? = null
    var size = 0L
    try {
        context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) {
                name = cursor.getString(0)
                if (!cursor.isNull(1)) size = cursor.getLong(1)
            }
        }
    } catch (_: Exception) {
    }
    val type = context.contentResolver.getType(uri)
        ?: (name ?: uri.lastPathSegment)?.substringAfterLast('.', "")?.lowercase()?.let { MimeTypeMap.getSingleton().getMimeTypeFromExtension(it) }
        ?: "application/octet-stream"
    val resolved = when {
        kind != PickedKind.File -> if (type.startsWith("video/")) PickedKind.Video else PickedKind.Photo
        else -> kind
    }
    return PickedMedia(uri.toString(), resolved, name ?: uri.lastPathSegment ?: "file", type, size)
}

/** The clipboard's image, when its first item is one. */
private fun clipboardImage(context: Context): Uri? {
    val clipboard = context.getSystemService(ClipboardManager::class.java) ?: return null
    val clip = try {
        clipboard.primaryClip
    } catch (_: SecurityException) {
        null
    } ?: return null
    if (clip.itemCount == 0 || !clip.description.hasMimeType("image/*")) return null
    return clip.getItemAt(0).uri
}

private tailrec fun Context.findActivity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.findActivity()
    else -> null
}
