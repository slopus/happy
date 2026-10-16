package com.slopus.happy.ui.components

import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import coil3.ImageLoader
import coil3.compose.AsyncImage
import coil3.compose.AsyncImagePainter
import coil3.disk.DiskCache
import coil3.disk.directory
import coil3.memory.MemoryCache
import coil3.network.okhttp.OkHttpNetworkFetcherFactory
import coil3.request.ImageRequest
import coil3.request.crossfade
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

/**
 * The app's one image loader (Coil 3), for every picture that isn't
 * bundled: profile pictures by URL, markdown images, decrypted
 * attachments. A memory cache (a fifth of the app's memory budget) and a
 * 128 MB disk cache for URLs, as expo-image keeps; downloads on its own
 * OkHttp client with no Happy headers, since these URLs are third-party.
 */
object HappyImageLoader {
    @Volatile private var instance: ImageLoader? = null

    fun get(context: Context): ImageLoader = instance ?: synchronized(this) {
        instance ?: build(context.applicationContext).also { instance = it }
    }

    private fun build(context: Context): ImageLoader {
        val client = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .build()
        return ImageLoader.Builder(context)
            .components { add(OkHttpNetworkFetcherFactory(callFactory = { client })) }
            .memoryCache { MemoryCache.Builder().maxSizePercent(context, 0.2).build() }
            .diskCache { DiskCache.Builder().directory(context.cacheDir.resolve("images")).maxSizeBytes(128L * 1024 * 1024).build() }
            .crossfade(FADE_MS)
            .build()
    }

    /** expo-image's `transition` in happy-app's image views. */
    const val FADE_MS = 150
}

/** Tests swap the loader (coil-test's fake engine); the app uses [HappyImageLoader]. */
val LocalImageLoader = staticCompositionLocalOf<ImageLoader?> { null }

@Composable
fun rememberImageLoader(): ImageLoader {
    val local = LocalImageLoader.current
    val context = LocalContext.current
    return local ?: remember(context) { HappyImageLoader.get(context) }
}

/** A remote picture's progress, for placeholders and error badges. */
enum class RemoteImageState { Loading, Success, Error }

object RemoteImageTags {
    const val IMAGE = "remote-image"
}

/** http(s) URLs load through [RemoteImage]; `data:` URIs and files have their own paths. */
fun isRemoteImageUrl(url: String?): Boolean = url != null && (url.startsWith("https://", ignoreCase = true) || url.startsWith("http://", ignoreCase = true))

/**
 * A picture loaded by the shared loader: [model] is a URL, or decrypted
 * bytes with a [cacheKey] (an attachment ref) so they are decoded once.
 * [background] shows until the picture lands and stays if it never does.
 */
@Composable
fun RemoteImage(
    model: Any?,
    contentDescription: String?,
    modifier: Modifier = Modifier,
    contentScale: ContentScale = ContentScale.Crop,
    alignment: Alignment = Alignment.Center,
    background: Color = Color.Transparent,
    cacheKey: String? = null,
    onState: (RemoteImageState) -> Unit = {},
) {
    val context = LocalContext.current
    val loader = rememberImageLoader()
    val request = remember(model, cacheKey, context) {
        ImageRequest.Builder(context)
            .data(model)
            .apply { if (cacheKey != null) memoryCacheKey(cacheKey) }
            .build()
    }
    var state by remember(request) { mutableStateOf(RemoteImageState.Loading) }
    Box(modifier.background(if (state == RemoteImageState.Success) Color.Transparent else background)) {
        AsyncImage(
            model = request,
            contentDescription = contentDescription,
            imageLoader = loader,
            contentScale = contentScale,
            alignment = alignment,
            modifier = Modifier.matchParentSize().testTag(RemoteImageTags.IMAGE),
            onState = { painterState ->
                val next = when (painterState) {
                    is AsyncImagePainter.State.Success -> RemoteImageState.Success
                    is AsyncImagePainter.State.Error -> RemoteImageState.Error
                    else -> RemoteImageState.Loading
                }
                if (next != state) {
                    state = next
                    onState(next)
                }
            },
        )
    }
}
