package com.slopus.happy.camera

import android.net.Uri
import androidx.annotation.MainThread
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import com.slopus.happy.attachments.AttachmentPreview
import com.slopus.happy.attachments.ImageNormalizer
import java.io.File
import java.io.IOException
import java.util.UUID
import java.util.concurrent.Executors
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext

/** Camera callbacks and disposal can outlive the sheet's cancelled coroutine scope. */
internal val PhotoExecutor = Executors.newSingleThreadExecutor()

internal data class CapturedPhoto(val attachment: AttachmentPreview, val directory: File)

/**
 * CameraX writes its JPEG off Main; normalize upright to the composer's 3072px JPEG
 * before Review. Use Photo can therefore transfer an already-ready attachment.
 * Both cancellation and a late CameraX callback remove abandoned output on IO.
 */
@MainThread
internal suspend fun capturePhoto(
    capture: ImageCapture,
    files: PhotoFiles,
    mirrored: Boolean,
    maxBytes: Long,
    cropRatio: Double? = null,
    onStarted: () -> Unit = {},
): CapturedPhoto {
    // Assign inside the IO block so cancellation on its return still knows what to clean.
    var allocated: File? = null
    try {
        withContext(Dispatchers.IO) { allocated = files.allocate() }
        val directory = checkNotNull(allocated)
        val raw = File(directory, "capture.jpg")
        suspendCancellableCoroutine<Unit> { continuation ->
            val metadata = ImageCapture.Metadata().apply { isReversedHorizontal = mirrored }
            val output = ImageCapture.OutputFileOptions.Builder(raw).setMetadata(metadata).build()
            continuation.invokeOnCancellation { PhotoExecutor.execute { files.discard(directory) } }
            capture.takePicture(output, PhotoExecutor, object : ImageCapture.OnImageSavedCallback {
                override fun onCaptureStarted() = onStarted()

                override fun onImageSaved(result: ImageCapture.OutputFileResults) {
                    if (continuation.isActive && files.holds(directory)) continuation.resume(Unit)
                    else {
                        files.discard(directory)
                        if (continuation.isActive) continuation.cancel(CancellationException("Capture discarded"))
                    }
                }

                override fun onError(exception: ImageCaptureException) {
                    files.discard(directory)
                    if (continuation.isActive) continuation.resumeWithException(exception)
                }
            })
        }
        return withContext(Dispatchers.IO) {
            val normalized = try {
                ImageNormalizer.normalize(raw::inputStream, "photo.jpg", directory, cropRatio = cropRatio)
            } finally {
                raw.delete()
            }
            if (normalized.size > maxBytes) throw IOException("Captured photo exceeds attachment limit")
            if (!files.holds(directory)) throw CancellationException("Capture discarded")
            CapturedPhoto(
                AttachmentPreview(
                    id = UUID.randomUUID().toString(),
                    uri = Uri.fromFile(normalized.file).toString(),
                    width = normalized.width,
                    height = normalized.height,
                    mimeType = normalized.mimeType,
                    size = normalized.size,
                    name = normalized.name,
                ),
                directory,
            )
        }
    } catch (e: Throwable) {
        withContext(NonCancellable + Dispatchers.IO) { allocated?.let(files::discard) }
        throw e
    }
}
