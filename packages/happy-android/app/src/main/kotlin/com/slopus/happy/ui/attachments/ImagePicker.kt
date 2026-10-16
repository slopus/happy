package com.slopus.happy.ui.attachments

import android.content.ClipboardManager
import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalResources
import com.slopus.happy.R
import com.slopus.happy.attachments.AttachmentPreview
import com.slopus.happy.attachments.ImageNormalizer
import com.slopus.happy.attachments.MAX_IMAGES_PER_MESSAGE
import com.slopus.happy.attachments.MAX_IMAGE_FILE_SIZE
import com.slopus.happy.attachments.MAX_NORMALIZED_FILE_SIZE
import com.slopus.happy.text.plural
import com.slopus.happy.ui.components.Alert
import com.slopus.happy.ui.components.AlertButton
import com.slopus.happy.ui.components.HappyAlert
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.util.UUID

/** Where a picked or pasted image comes from: its stream (opened more than once) and its file name. */
class ImageSource(val name: String?, val open: () -> InputStream)

/**
 * useImagePicker.ts: the images waiting to go with the next message, and
 * the alerts its add, pick and paste paths show. Pure state; the system
 * picker and clipboard come in through [ImagePicker].
 */
@Stable
class ImageAttachmentsState(
    private val normalize: (ImageSource) -> com.slopus.happy.attachments.NormalizedImage,
    private val text: ImagePickerText,
) {
    val images = mutableStateListOf<AttachmentPreview>()
    var alert by mutableStateOf<Alert?>(null)
        internal set

    val remaining: Int get() = MAX_IMAGES_PER_MESSAGE - images.size

    fun remove(id: String) {
        images.removeAll { it.id == id }
    }

    fun clear() = images.clear()

    /** The "Image Limit Reached" alert when 20 are already attached. False when there is no room. */
    fun checkRoom(): Boolean {
        if (remaining > 0) return true
        alert = Alert(text.limitTitle, text.limitMessage, listOf(AlertButton(text.ok)))
        return false
    }

    /** previewForAsset for each source, then adds what passed (never past 20). */
    suspend fun add(sources: List<ImageSource>) {
        val previews = sources.take(remaining.coerceAtLeast(0)).mapNotNull { preview(it) }
        val room = remaining
        if (room > 0) images.addAll(previews.take(room))
    }

    /** "Nothing to Paste": the clipboard had no image. */
    fun nothingToPaste() {
        alert = Alert(text.nothingToPasteTitle, text.nothingToPasteMessage, listOf(AlertButton(text.ok)))
    }

    /** The add button's chooser: Paste from Clipboard, Photo Library, Cancel. */
    fun choose(onPaste: () -> Unit, onPick: () -> Unit) {
        alert = Alert(
            text.attachTitle,
            null,
            listOf(AlertButton(text.paste, onClick = onPaste), AlertButton(text.library, onClick = onPick), AlertButton(text.cancel)),
        )
    }

    fun dismissAlert() {
        alert = null
    }

    private suspend fun preview(source: ImageSource): AttachmentPreview? {
        val normalized = try {
            withContext(Dispatchers.IO) { normalize(source) }
        } catch (_: Exception) {
            alert = Alert(text.uploadFailedTitle, text.uploadFailedOne, listOf(AlertButton(text.ok)))
            return null
        }
        if (normalized.size > MAX_NORMALIZED_FILE_SIZE) {
            normalized.file.delete()
            alert = Alert(text.tooLargeTitle, text.tooLargeMessage(source.name ?: "image", MAX_IMAGE_FILE_SIZE / 1024 / 1024), listOf(AlertButton(text.ok)))
            return null
        }
        return AttachmentPreview(
            id = UUID.randomUUID().toString(),
            uri = Uri.fromFile(normalized.file).toString(),
            width = normalized.width,
            height = normalized.height,
            mimeType = normalized.mimeType,
            size = normalized.size,
            name = normalized.name,
        )
    }
}

/** The catalog strings the picker shows. */
data class ImagePickerText(
    val ok: String,
    val cancel: String,
    val limitTitle: String,
    val limitMessage: String,
    val tooLargeTitle: String,
    val tooLargeMessage: (name: String, maxMb: Int) -> String,
    val uploadFailedTitle: String,
    val uploadFailedOne: String,
    val nothingToPasteTitle: String,
    val nothingToPasteMessage: String,
    val attachTitle: String,
    val paste: String,
    val library: String,
)

/** What the composer's add button and paste use. */
@Stable
class ImagePicker internal constructor(
    val state: ImageAttachmentsState,
    private val scope: CoroutineScope,
    private val launchPicker: (Int) -> Unit,
    private val readClipboard: () -> ImageSource?,
) {
    val images: List<AttachmentPreview> get() = state.images

    /** attachImages: asks, every time, whether to paste or to pick. */
    fun attach() = state.choose(onPaste = ::paste, onPick = ::pick)

    /** pickImages: the system photo picker, for up to the room left. */
    fun pick() {
        if (state.checkRoom()) launchPicker(state.remaining)
    }

    /** pasteImages: the image on the clipboard, or "Nothing to Paste". */
    fun paste() {
        if (!state.checkRoom()) return
        val source = readClipboard() ?: return state.nothingToPaste()
        scope.launch { state.add(listOf(source)) }
    }

    fun remove(id: String) = state.remove(id)
    fun clear() = state.clear()

    internal fun picked(uris: List<Uri>, sources: (Uri) -> ImageSource) {
        if (uris.isEmpty()) return
        scope.launch { state.add(uris.take(state.remaining.coerceAtLeast(0)).map(sources)) }
    }
}

/**
 * [ImagePicker] for this screen. The Android photo picker needs no storage
 * permission (happy-app blocks READ_MEDIA_IMAGES); images are normalized
 * into the cache directory, where the upload reads them. Shows its own
 * alerts while composed.
 */
@Composable
fun rememberImagePicker(): ImagePicker {
    val context = LocalContext.current
    val resources = LocalResources.current
    val scope = rememberCoroutineScope()
    val text = remember(resources) {
        ImagePickerText(
            ok = resources.getString(R.string.common_ok),
            cancel = resources.getString(R.string.common_cancel),
            limitTitle = resources.getString(R.string.image_upload_limit_title),
            limitMessage = resources.getString(R.string.image_upload_limit_message, MAX_IMAGES_PER_MESSAGE),
            tooLargeTitle = resources.getString(R.string.image_upload_file_too_large_title),
            tooLargeMessage = { name, maxMb -> resources.getString(R.string.image_upload_file_too_large_message, name, maxMb) },
            uploadFailedTitle = resources.getString(R.string.image_upload_upload_failed_title),
            uploadFailedOne = resources.plural(R.plurals.image_upload_upload_failed_message, 1),
            nothingToPasteTitle = resources.getString(R.string.image_upload_nothing_to_paste_title),
            nothingToPasteMessage = resources.getString(R.string.image_upload_nothing_to_paste_message),
            attachTitle = resources.getString(R.string.image_upload_attach_title),
            paste = resources.getString(R.string.image_upload_paste_from_clipboard),
            library = resources.getString(R.string.image_upload_choose_from_library),
        )
    }
    val state = remember(text) {
        ImageAttachmentsState(normalize = { source -> ImageNormalizer.normalize(source.open, source.name, attachmentCacheDir(context)) }, text = text)
    }
    var pickerRef by remember { mutableStateOf<ImagePicker?>(null) }
    val current by rememberUpdatedState(pickerRef)
    val single = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        current?.picked(listOfNotNull(uri)) { contentSource(context, it) }
    }
    val multiple = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(MAX_IMAGES_PER_MESSAGE)) { uris ->
        current?.picked(uris) { contentSource(context, it) }
    }
    val picker = remember(state, scope) {
        ImagePicker(
            state = state,
            scope = scope,
            launchPicker = { remaining ->
                val request = PickVisualMediaRequest.Builder()
                    .setMediaType(ActivityResultContracts.PickVisualMedia.ImageOnly)
                    .build()
                // The multiple picker needs room for at least two; its limit is fixed at
                // registration, so the room left is enforced again when the result lands.
                if (remaining == 1) single.launch(request) else multiple.launch(request)
            },
            readClipboard = { clipboardImage(context) },
        )
    }
    pickerRef = picker
    state.alert?.let { HappyAlert(it, onDismiss = state::dismissAlert) }
    return picker
}

/** Where normalized attachments are written: the cache, which the system may clear. */
fun attachmentCacheDir(context: Context): File = File(context.cacheDir, "attachments").apply { mkdirs() }

private fun contentSource(context: Context, uri: Uri) = ImageSource(displayName(context, uri)) {
    context.contentResolver.openInputStream(uri) ?: throw IOException("Cannot open image")
}

private fun displayName(context: Context, uri: Uri): String? = try {
    context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
        if (cursor.moveToFirst()) cursor.getString(0) else null
    }
} catch (_: Exception) {
    null
}

/** The clipboard's image, when its first item is one (expo-clipboard hasImageAsync/getImageAsync). */
internal fun clipboardImage(context: Context): ImageSource? {
    val clipboard = context.getSystemService(ClipboardManager::class.java) ?: return null
    val clip = try {
        clipboard.primaryClip
    } catch (_: SecurityException) {
        null
    } ?: return null
    if (clip.itemCount == 0 || !clip.description.hasMimeType("image/*")) return null
    val uri = clip.getItemAt(0).uri ?: return null
    return ImageSource("pasted_${System.currentTimeMillis()}.png") {
        context.contentResolver.openInputStream(uri) ?: throw IOException("Cannot open pasted image")
    }
}
