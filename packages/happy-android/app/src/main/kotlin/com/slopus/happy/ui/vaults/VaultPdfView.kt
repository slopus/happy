package com.slopus.happy.ui.vaults

import android.graphics.Bitmap
import android.graphics.pdf.PdfRenderer
import android.os.ParcelFileDescriptor
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.slopus.happy.ui.components.LoadingIndicator
import com.slopus.happy.ui.components.barInsetTop
import com.slopus.happy.ui.theme.HappyTheme
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.File

object VaultPdfTags {
    const val PAGES = "vault.pdf.pages"
    const val PAGE = "vault.pdf.page"
}

/**
 * A PDF read on the phone (the platform's [PdfRenderer]): its pages one
 * under another, 12 apart on the page's ground, each the width of the
 * column at its own shape, drawn as it scrolls into view at the screen's
 * pixels. One page renders at a time, as the renderer requires.
 */
@Composable
internal fun VaultPdfView(file: File, onFailed: () -> Unit) {
    val document = remember(file) { PdfDocument(file) }
    DisposableEffect(document) { onDispose { document.close() } }
    val pages by produceState<List<Float>?>(null, document) {
        value = withContext(Dispatchers.IO) { runCatching { document.ratios() }.getOrNull() }
        if (value == null) onFailed()
    }
    val ratios = pages ?: return LoadingIndicator()
    BoxWithConstraints(Modifier.fillMaxSize().background(HappyTheme.colors.surfaceHigh)) {
        val width = with(LocalDensity.current) { maxWidth.roundToPx() }
        LazyColumn(
            Modifier.fillMaxSize().testTag(VaultPdfTags.PAGES),
            contentPadding = PaddingValues(top = barInsetTop() + 12.dp, bottom = 32.dp, start = 12.dp, end = 12.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            items(ratios.size) { index ->
                val bitmap by produceState<Bitmap?>(null, document, index, width) {
                    value = withContext(Dispatchers.IO) { runCatching { document.render(index, width) }.getOrNull() }
                }
                Box(Modifier.fillMaxWidth().aspectRatio(ratios[index]).background(Color.White).testTag(VaultPdfTags.PAGE)) {
                    bitmap?.let { Image(it.asImageBitmap(), contentDescription = null, contentScale = ContentScale.FillWidth, modifier = Modifier.fillMaxSize()) }
                }
            }
        }
    }
}

/** One open PDF, its pages' shapes, and pages rendered one at a time. */
private class PdfDocument(file: File) {
    private val lock = Mutex()
    private var descriptor: ParcelFileDescriptor? = null
    private var renderer: PdfRenderer? = null
    private val path = file

    private fun open(): PdfRenderer = renderer ?: PdfRenderer(ParcelFileDescriptor.open(path, ParcelFileDescriptor.MODE_READ_ONLY).also { descriptor = it }).also { renderer = it }

    /** Each page's width over its height. */
    suspend fun ratios(): List<Float> = lock.withLock {
        val pdf = open()
        (0 until pdf.pageCount).map { index -> pdf.openPage(index).use { it.width.toFloat() / it.height.coerceAtLeast(1) } }
    }

    suspend fun render(index: Int, width: Int): Bitmap = lock.withLock {
        open().openPage(index).use { page ->
            val height = (width.toLong() * page.height / page.width.coerceAtLeast(1)).toInt().coerceAtLeast(1)
            val bitmap = Bitmap.createBitmap(width.coerceAtLeast(1), height, Bitmap.Config.ARGB_8888)
            bitmap.eraseColor(android.graphics.Color.WHITE)
            page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
            bitmap
        }
    }

    fun close() {
        runCatching { renderer?.close() }
        runCatching { descriptor?.close() }
    }
}
