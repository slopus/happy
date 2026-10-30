package com.slopus.happy.conversation

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.util.Base64

/**
 * Pictures travel inside the message (API.md `POST /v0/agents/:agentId/send`
 * `content`), base64 in an image block, so they must fit what the model
 * takes: at most 5 MiB each and 29 MiB together (happy-ios AttachmentRules).
 */
object InlinePictures {
    const val MAX_BYTES = 5 * 1024 * 1024
    const val MAX_TOTAL_BYTES = 29 * 1024 * 1024
    private const val SHRINK_QUALITY = 85

    /** Whether pictures of these sizes go in one message, each larger one shrunk to the limit. */
    fun fit(sizes: List<Long>): Boolean = sizes.sumOf { minOf(it, MAX_BYTES.toLong()) } <= MAX_TOTAL_BYTES

    /** The image blocks for [files] (JPEGs the composer normalized); a picture over the limit is shrunk until it fits. */
    fun read(files: List<File>): List<Block.Image> {
        var total = 0L
        return files.map { file ->
            var bytes = file.readBytes()
            var sample = 2
            while (bytes.size > MAX_BYTES) {
                if (sample > 16) throw IOException("Picture too large")
                bytes = shrink(file, sample)
                sample *= 2
            }
            total += bytes.size
            if (total > MAX_TOTAL_BYTES) throw IOException("Pictures too large")
            Block.Image("image/jpeg", Base64.getEncoder().encodeToString(bytes))
        }
    }

    private fun shrink(file: File, sample: Int): ByteArray {
        val bitmap = BitmapFactory.decodeFile(file.path, BitmapFactory.Options().apply { inSampleSize = sample })
            ?: throw IOException("Not an image")
        try {
            return ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.JPEG, SHRINK_QUALITY, it) }.toByteArray()
        } finally {
            bitmap.recycle()
        }
    }
}
