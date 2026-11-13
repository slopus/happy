package com.slopus.happy.ui.attach

import android.graphics.Bitmap
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.mutableStateMapOf
import com.slopus.happy.attachments.ATTACHMENT_JPEG_QUALITY
import com.slopus.happy.attachments.ImageNormalizer
import com.slopus.happy.ui.photoedit.PhotoEdit
import com.slopus.happy.ui.photoedit.PhotoPainting
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.util.UUID
import kotlin.concurrent.thread

/**
 * A photo as edited in the sheet: its edit, the JPEG that makes, which
 * making of it this is, and whether it is [cropped] (cut, turned or
 * mirrored) and [drawn] on, which the viewer's buttons show.
 */
@Immutable
data class EditedPhoto(
    val edit: PhotoEdit,
    val file: File,
    val width: Int,
    val height: Int,
    val revision: Int,
    val cropped: Boolean,
    val drawn: Boolean,
)

/**
 * What the sheet's photos were edited into, by gallery URI, as Telegram
 * keeps each photo's edits on its entry: the grid shows the edited one, the
 * viewer pages it, and it is what is staged and sent. Each edit is a JPEG of
 * its own under [directory], which goes with the sheet ([clear]). The photo
 * an edit is measured on ([working]) is the one staging would send: upright,
 * at most 3072 ([ImageNormalizer]).
 */
@Stable
class AttachEdits(private val directory: File) {
    private val edited = mutableStateMapOf<String, EditedPhoto>()
    private var working: Pair<String, Bitmap>? = null

    operator fun get(key: String): EditedPhoto? = edited[key]

    /** 0 until [key] is edited, then one more each time. */
    fun revision(key: String): Int = edited[key]?.revision ?: 0

    /** [key]'s photo upright, as its edits are measured; the last one read is kept for the next edit. */
    suspend fun working(key: String, open: () -> InputStream): Bitmap? {
        working?.let { (at, bitmap) -> if (at == key) return bitmap }
        return withContext(Dispatchers.IO) {
            try {
                ImageNormalizer.decode(open)
            } catch (_: IOException) {
                null
            } catch (_: SecurityException) {
                null
            }
        }?.also { bitmap ->
            working = key to bitmap
        }
    }

    /** [key] edited into [edit] on [photo]: drawn and cut into a JPEG; an edit of nothing puts the photo back as it was. */
    suspend fun save(key: String, photo: Bitmap, edit: PhotoEdit): EditedPhoto? {
        val previous = edited[key]
        if (edit.isEmpty(photo.width, photo.height)) {
            edited.remove(key)
            previous?.file?.let { withContext(Dispatchers.IO) { it.delete() } }
            return null
        }
        val saved = withContext(Dispatchers.Default) {
            val rendered = PhotoPainting.render(photo, edit)
            try {
                directory.mkdirs()
                val file = File(directory, "${UUID.randomUUID()}.jpg")
                file.outputStream().use { rendered.compress(Bitmap.CompressFormat.JPEG, ATTACHMENT_JPEG_QUALITY, it) }
                EditedPhoto(
                    edit, file, rendered.width, rendered.height, (previous?.revision ?: 0) + 1,
                    cropped = !edit.crop.isIdentity(photo.width, photo.height),
                    drawn = edit.strokes.isNotEmpty(),
                )
            } finally {
                rendered.recycle()
            }
        }
        edited[key] = saved
        previous?.file?.let { withContext(Dispatchers.IO) { it.delete() } }
        return saved
    }

    /** Everything edited is gone with the sheet, its files off the main thread. */
    fun clear() {
        edited.clear()
        working = null
        thread(name = "attach-edits") { directory.deleteRecursively() }
    }
}
