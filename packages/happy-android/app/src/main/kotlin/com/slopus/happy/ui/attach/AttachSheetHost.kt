package com.slopus.happy.ui.attach

import androidx.compose.runtime.DisposableEffect
import com.slopus.happy.ui.components.WindowDialog
import android.content.res.Configuration
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.ui.Alignment
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
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
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
import com.slopus.happy.ui.components.rememberImageLoader
import coil3.ImageLoader
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import com.slopus.happy.ui.components.TrackOverlay
import com.slopus.happy.ui.conversation.PictureViewer
import com.slopus.happy.ui.conversation.ViewerSource
import com.slopus.happy.ui.files.WorkspaceFilePicker
import com.slopus.happy.ui.files.WorkspaceSource
import com.slopus.happy.ui.files.withWorkspacePath
import com.slopus.happy.ui.theme.DarkColors
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileInputStream
import java.io.InputStream
import java.util.UUID
import android.graphics.Bitmap
import androidx.compose.runtime.produceState
import com.slopus.happy.ui.camera.CameraShot
import com.slopus.happy.ui.photoedit.PhotoCrop
import com.slopus.happy.ui.photoedit.PhotoEdit
import com.slopus.happy.ui.photoedit.PhotoEditMode
import com.slopus.happy.ui.photoedit.PhotoEditor
import java.io.IOException
import java.nio.ByteBuffer

/**
 * The attachment sheet over the whole window while [open]: Telegram's
 * gallery of recent photos and videos (asking for access the first time)
 * and its File tab, as [accepts] allows. What is picked goes with the
 * [caption] (the composer's words, edited here too) once Send is pressed:
 * each pick is copied into the app's cache first ([AttachmentStaging]),
 * then [onSend] has them. The header's confirm pill (a check and the
 * count) sends nothing: the picks are copied the same way, [onAttach] puts
 * them in the composer, and the sheet goes. Room is [room] picks.
 * [onClosed] runs once the sheet has gone, after its own close. On a phone
 * held upright it grows out of [button] and goes back into it
 * ([AttachMorph]). With a [workspace] the File tab can name one of its
 * files instead: the picked path goes into the caption as `./path` and
 * nothing is uploaded. With [onSendPending], gallery photos don't wait to
 * be read on Send: the sheet goes at once and each goes as its thumbnail,
 * read after ([PendingPicture]). The preview pages the photos with the
 * caption and Send at its foot, and Telegram's crop and drawing
 * ([PhotoEditor]): an edited photo is what the grid shows and what goes
 * ([AttachEdits]). With [takesPhotos], the grid's first tile is the camera:
 * each photo it takes lands at the grid's head picked, the first opens in
 * the preview, and Back there returns to the camera, which keeps them in a
 * strip (Telegram-Android's `ChatAttachAlertPhotoLayout`).
 */
@Composable
fun AttachSheet(
    open: Boolean,
    accepts: AttachAccepts,
    caption: String,
    onCaptionChange: (String) -> Unit,
    onSend: (List<AttachmentPreview>) -> Unit,
    onAttach: (List<AttachmentPreview>) -> Unit,
    onClosed: () -> Unit,
    room: Int = accepts.maxItems,
    button: AttachButton? = null,
    workspace: WorkspaceSource? = null,
    onSendPending: ((List<AttachmentPreview>, List<PendingPicture>) -> Unit)? = null,
    takesPhotos: Boolean = false,
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
    val camera = remember { AttachCameraState() }.takeIf { accepts.photos && takesPhotos }
    val selection = remember { AttachSelection(room.coerceAtLeast(0)) }
    val closed by rememberUpdatedState(onClosed)
    val send by rememberUpdatedState(onSend)
    val sendPending by rememberUpdatedState(onSendPending)
    val attach by rememberUpdatedState(onAttach)
    var tab by remember { mutableStateOf(tabs.first()) }
    var alert by remember { mutableStateOf<Alert?>(null) }
    var sending by remember { mutableStateOf(false) }
    var staging by remember { mutableStateOf(false) }
    var viewing by remember { mutableStateOf<Viewing?>(null) }
    var editing by remember { mutableStateOf<Editing?>(null) }
    val edits = remember { AttachEdits(File(context.cacheDir, "attachments/edits/${UUID.randomUUID()}")) }
    DisposableEffect(edits) { onDispose { edits.clear() } }
    // The camera's photos, newest first, at the grid's head.
    val shots = remember { mutableStateListOf<GalleryItem>() }
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
    val all = shots.toList() + items
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
        if (sending || staging || selection.count == 0) return
        sending = true
        val picks = selection.items.toList()
        val later = sendPending
        val app = context.applicationContext
        val staging = AttachmentStaging(attachmentCacheDir(app)) { pick -> openPick(app, edits, pick) }
        scope.launch {
            try {
                // A gallery photo goes as its thumbnail, read once the sheet has gone (iOS b03dd48cc); an edited one is read now.
                val photos = if (later == null) emptyList() else picks.filter { it.kind == PickedKind.Photo && edits[it.uri] == null }
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

    fun confirm() {
        if (staging || sending || selection.count == 0) return
        staging = true
        val picks = selection.items.toList()
        val app = context.applicationContext
        val stager = AttachmentStaging(attachmentCacheDir(app)) { pick -> openPick(app, edits, pick) }
        scope.launch {
            try {
                // Each pick read on its own, a few at a time, and put back in the order picked.
                val staged = withContext(Dispatchers.IO) {
                    picks.map { pick -> async(StagingDispatcher) { stager.stage(listOf(pick), accepts) } }.awaitAll()
                }.let { parts -> Staged(parts.flatMap { it.attachments }, parts.flatMap { it.problems }) }
                staged.problems.firstOrNull()?.let { problem ->
                    when (problem) {
                        is StagingProblem.TooLarge -> say(R.string.image_upload_file_too_large_title, resources.getString(R.string.image_upload_file_too_large_message, problem.name, problem.maxMb))
                        is StagingProblem.Unreadable -> say(R.string.image_upload_upload_failed_title, resources.getString(R.string.attach_unreadable_message, problem.name))
                    }
                }
                if (staged.attachments.isEmpty()) return@launch
                val files = picks.filter { it.kind == PickedKind.File && it.uri.startsWith("content:") }
                if (files.isNotEmpty() && accepts.files) withContext(Dispatchers.IO) { RecentFiles(context).remember(files) }
                attach(staged.attachments)
                if (staged.problems.isEmpty()) close()
                else selection.clear()
            } finally {
                staging = false
            }
        }
    }

    WindowDialog(
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
            gallery = GalleryContent(access, all, loaded, blocked, edits),
            sources = FileSources(browse = accepts.files, gallery = accepts.files || accepts.photos, paste = accepts.photos || accepts.files, workspace = workspace != null),
            recent = (picked + sent.filter { old -> picked.none { it.uri == old.uri } }),
            selection = selection,
            caption = caption,
            onCaptionChange = onCaptionChange,
            motion = motion,
            onClose = ::close,
            onSend = ::sendPicks,
            onConfirm = ::confirm,
            onToggleGallery = { toggle(it.picked()) },
            onOpenGallery = { item -> viewing = all.indexOf(item).takeIf { it >= 0 }?.let { Viewing(camera = false, index = it) } },
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
            busy = staging,
            camera = camera,
        )
        if (camera != null) AttachCamera(
            state = camera, visible = tab == AttachTabKind.Gallery && viewing == null && !naming && !motion.closing,
            maxBytes = accepts.maxFileBytes,
            hasRoom = {
                if (selection.count < selection.maxItems) true else {
                    say(R.string.image_upload_limit_title, resources.getString(R.string.attach_limit_message, accepts.maxItems))
                    false
                }
            },
            onShot = { photo ->
                val item = GalleryItem(-(shots.size + 1L), photo.uri, false, photo.mimeType, photo.name, photo.size, photo.width, photo.height, 0)
                shots.add(0, item)
                selection.pick(item.picked())
                // Telegram opens the first in the preview, with the caption; the rest wait in the strip.
                if (shots.size == 1) viewing = Viewing(camera = true, index = 0)
            },
            shots = shots.map { CameraShot(CAMERA_KEY + it.uri, edits[it.uri]?.file ?: it.uri, selection.number(it.uri)) },
            picked = selection.count,
            onShots = { index -> viewing = Viewing(camera = true, index = index) },
            paused = viewing != null || editing != null,
        )
        viewing?.let { open ->
            // From the camera the preview pages its photos alone, keyed apart so they fly from its strip.
            val list = if (open.camera) shots.toList() else all
            fun keyOf(item: GalleryItem) = if (open.camera) CAMERA_KEY + item.uri else item.uri
            fun itemOf(key: String) = list.firstOrNull { keyOf(it) == key }
            val shown = remember(list, open.camera) { list.map { ViewerItem(keyOf(it), it.name, it.isVideo, it.width.toFloat().takeIf { w -> w > 0 }, it.height.toFloat().takeIf { h -> h > 0 }) } }
            val loader = rememberImageLoader()
            // The viewer is black in either theme, so its check takes the dark theme's colours.
            val colors = remember { AttachColors.of(dark = true) }
            PictureViewer(
                shown, open.index.coerceIn(0, (shown.size - 1).coerceAtLeast(0)), remember(context, loader, edits) { GallerySource(context, loader, edits) },
                // The picture in view picks and unpicks as its cell's check does.
                corner = { shownItem, modifier ->
                    val item = itemOf(shownItem.key) ?: return@PictureViewer
                    val number = selection.number(item.uri)
                    val label = stringResource(if (number > 0) R.string.attach_unpick else R.string.attach_pick)
                    Box(
                        modifier
                            .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) { toggle(item.picked()) }
                            .semantics {
                                contentDescription = label
                                role = Role.Checkbox
                                selected = number > 0
                            }
                            .testTag(AttachTags.PREVIEW_CHECK),
                        contentAlignment = Alignment.Center,
                    ) {
                        AttachCheck(number, DarkColors.surface, colors)
                    }
                },
                // The caption and Send, and the photo's edits, under it (Telegram's `PhotoViewer` picking).
                bottom = { shownItem, modifier ->
                    val item = itemOf(shownItem.key) ?: return@PictureViewer
                    AttachViewerFoot(
                        caption = caption,
                        onCaptionChange = onCaptionChange,
                        count = maxOf(1, selection.count),
                        sending = sending,
                        // Nothing picked, Send sends the photo in view.
                        onSend = {
                            if (selection.count > 0 || selection.pick(item.picked())) {
                                viewing = null
                                sendPicks()
                            }
                        },
                        edited = edits[item.uri],
                        editable = !item.isVideo,
                        onEdit = { mode -> editing = Editing(item, mode) },
                        modifier = modifier,
                    )
                },
                onClose = { viewing = null },
            )
        }
        editing?.let { open ->
            val app = context.applicationContext
            val photo by produceState<Bitmap?>(null, open.item.uri) {
                value = edits.working(open.item.uri) { app.contentResolver.openInputStream(Uri.parse(open.item.uri)) ?: throw IOException("Cannot open ${open.item.name}") }
                if (value == null) {
                    editing = null
                    say(R.string.image_upload_upload_failed_title, resources.getString(R.string.attach_unreadable_message, open.item.name))
                }
            }
            PhotoEditor(
                photo = photo,
                edit = edits[open.item.uri]?.edit,
                mode = open.mode,
                onCancel = { editing = null },
                onDone = { edit ->
                    val working = photo
                    editing = null
                    if (working != null) scope.launch {
                        val before = edits[open.item.uri]?.edit ?: PhotoEdit(PhotoCrop.whole(working.width, working.height))
                        edits.save(open.item.uri, working, edit)
                        // Done with a change picks the photo, as Telegram does.
                        if (edit != before) selection.pick(open.item.picked())
                    }
                },
            )
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

/** Picks read into the cache at once: a photo's decode is big, so a few at a time. */
private val StagingDispatcher = Dispatchers.IO.limitedParallelism(3)

/** The viewer's key for a photo the camera took, opened from its strip. */
private const val CAMERA_KEY = "camera:"

/** The preview opened over the grid's photos, or the camera's ([camera]), at [index]. */
private data class Viewing(val camera: Boolean, val index: Int)

/** A photo being cropped or drawn on. */
private data class Editing(val item: GalleryItem, val mode: PhotoEditMode)

/** A pick's bytes: as edited, if it was; else as the gallery or the camera has them. */
private fun openPick(context: Context, edits: AttachEdits, pick: PickedMedia): InputStream =
    edits[pick.uri]?.file?.inputStream()
        ?: context.contentResolver.openInputStream(Uri.parse(pick.uri))
        ?: throw IOException("Cannot open ${pick.name}")

/**
 * The preview's pictures and recordings: read straight from the gallery, the
 * grid's thumbnail first; an edited photo as edited, read again each time it is.
 */
private class GallerySource(private val context: Context, private val loader: ImageLoader, private val edits: AttachEdits) : ViewerSource {
    private fun uri(key: String) = key.removePrefix(CAMERA_KEY)

    override fun thumbnail(key: String): ImageBitmap? =
        if (edits[uri(key)] != null) null else galleryThumbBitmap(loader, uri(key))?.asImageBitmap()

    override fun revision(key: String): Int = edits.revision(uri(key))

    override suspend fun bytes(key: String): ByteArray? = withContext(Dispatchers.IO) {
        edits[uri(key)]?.file?.takeIf { it.exists() }?.readBytes()
            ?: context.contentResolver.openInputStream(Uri.parse(uri(key)))?.use { it.readBytes() }
    }

    override fun video(key: String): MediaDataSource? = try {
        context.contentResolver.openFileDescriptor(Uri.parse(uri(key)), "r")?.let(::FileSource)
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
