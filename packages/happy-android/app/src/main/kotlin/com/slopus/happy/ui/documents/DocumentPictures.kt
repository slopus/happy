package com.slopus.happy.ui.documents

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.LruCache
import com.slopus.happy.agent.AgentClient
import com.slopus.happy.connection.RequestCategory
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request

/**
 * Pictures in documents (iOS's `DocumentViewController.picture` and
 * `DocumentObjectAttachment.pictures`): a `/v0/` path read through the
 * agent's client, an http(s) address directly, anything else not at all.
 * Read once, decoded no wider than the screen, and kept by address for
 * every document.
 */
object DocumentPictures {
    /** About a long document's pictures on screen and around it. */
    private const val CACHE_BYTES = 32 * 1024 * 1024

    private val kept = object : LruCache<String, DocumentPicture>(CACHE_BYTES) {
        override fun sizeOf(key: String, value: DocumentPicture) = value.bitmap.allocationByteCount
    }

    private val http by lazy { OkHttpClient() }

    fun cached(url: String): DocumentPicture? = kept.get(url)

    /** The picture at [url], read and decoded off the main thread; null when it can't be. */
    suspend fun load(client: AgentClient, url: String, widest: Int): DocumentPicture? {
        cached(url)?.let { return it }
        val picture = withContext(Dispatchers.IO) {
            try {
                bytes(client, url)?.let { decode(it, widest) }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                null
            }
        } ?: return null
        kept.put(url, picture)
        return picture
    }

    /** Keeps [picture] for [url], as a read would (for tests). */
    internal fun keep(url: String, picture: DocumentPicture) {
        kept.put(url, picture)
    }

    private suspend fun bytes(client: AgentClient, url: String): ByteArray? = when {
        url.startsWith("/v0/") -> client.send("GET", url, category = RequestCategory.File).body
        url.startsWith("https://") || url.startsWith("http://") ->
            http.newCall(Request.Builder().url(url).build()).execute().use { response -> if (response.isSuccessful) response.body.bytes() else null }
        else -> null
    }

    /** Decoded at the smallest power-of-two step still at least [widest] across. */
    private fun decode(bytes: ByteArray, widest: Int): DocumentPicture? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        var sample = 1
        while (widest > 0 && bounds.outWidth / (sample * 2) >= widest) sample *= 2
        val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample }) ?: return null
        return DocumentPicture(bitmap, bounds.outWidth, bounds.outHeight)
    }
}

/** A picture read, and its own size in pixels before any step down (as iOS sizes it, a pixel to a point). */
class DocumentPicture(val bitmap: Bitmap, val width: Int, val height: Int)
