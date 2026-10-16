package com.slopus.happy.ui.attachments

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.slopus.happy.AppGraph
import com.slopus.happy.attachments.AttachmentServices
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.RemoteImage
import com.slopus.happy.ui.components.RemoteImageState
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull

/** One session's attachments, as the chat rows read them. */
@Stable
interface SessionAttachments {
    /** The decrypted blob if it is already in memory. */
    fun cached(ref: String): ByteArray?

    /** The decrypted blob, downloaded if needed; null when it can't be had. */
    suspend fun load(ref: String): ByteArray?
}

/** The open chat's attachments; null outside a chat (rows then show no picture). */
val LocalSessionAttachments = compositionLocalOf<SessionAttachments?> { null }

/** [SessionAttachments] for [sessionId] over the signed-in account's transfers. */
@Composable
fun rememberSessionAttachments(graph: AppGraph, sessionId: String): SessionAttachments {
    val services = remember(graph) { AttachmentServices.of(graph) }
    return remember(services, sessionId) {
        object : SessionAttachments {
            override fun cached(ref: String) = services.transfers?.cached(ref)
            override suspend fun load(ref: String) = services.transfers?.load(sessionId, ref)
        }
    }
}

/** FileView.tsx's `fileInputSchema`: the `file` tool's input. Null where the schema rejects it. */
data class FileToolInput(val ref: String, val name: String, val size: Double?, val image: Image?) {
    data class Image(val width: Double, val height: Double, val thumbhash: String?)

    companion object {
        fun parse(input: JsonElement?): FileToolInput? {
            val o = input as? JsonObject ?: return null
            val ref = o.string("ref") ?: return null
            val name = o.string("name") ?: return null
            val size = when (val value = o["size"]) {
                null -> null
                else -> (value as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull ?: return null
            }
            val image = when (val value = o["image"]) {
                null -> null
                is JsonObject -> Image(
                    width = value.number("width") ?: return null,
                    height = value.number("height") ?: return null,
                    thumbhash = when (val thumbhash = value["thumbhash"]) {
                        null -> null
                        else -> (thumbhash as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return null
                    },
                )
                else -> return null
            }
            return FileToolInput(ref, name, size, image)
        }

        private fun JsonObject.string(key: String) = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
        private fun JsonObject.number(key: String) = (this[key] as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull
    }
}

/**
 * FileView.tsx's display size: the image's own width up to 280, the height
 * from its aspect ratio (4:3 when the event has no dimensions), and both
 * scaled down to keep the height within 360.
 */
fun fileImageDisplaySize(image: FileToolInput.Image?): Pair<Dp, Dp> {
    val known = image != null && image.width > 0 && image.height > 0
    val aspect = if (known) image!!.width / image.height else FileMessageSpec.DEFAULT_ASPECT
    var width = minOf(if (known) image!!.width else FileMessageSpec.MAX_WIDTH, FileMessageSpec.MAX_WIDTH)
    var height = width / aspect
    if (height > FileMessageSpec.MAX_HEIGHT) {
        height = FileMessageSpec.MAX_HEIGHT
        width = height * aspect
    }
    return width.dp to height.dp
}

/** Layout of a file row (FileView.tsx inside ToolView's inline container and MessageView's tool container). */
object FileMessageSpec {
    const val MAX_WIDTH = 280.0
    const val MAX_HEIGHT = 360.0
    const val DEFAULT_ASPECT = 4.0 / 3.0
    val rowMarginHorizontal = 8.dp
    val rowMarginVertical = 1.dp
    val paddingHorizontal = 12.dp
    val paddingVertical = 8.dp
    val gap = 4.dp
    val radius = 8.dp
    val errorInset = 4.dp
    val errorSize = 24.dp
    val errorIcon = 20.dp
    val filename = happyTextStyle(fontSize = 13, weight = FontWeight.Medium)
}

object FileMessageTags {
    const val ROW = "file-message"
    const val IMAGE = "file-message-image"
    const val ERROR = "file-message-error"
    const val NAME = "file-message-name"
}

/**
 * A `file` tool row: a picture the user attached (FileView.tsx), shown bare
 * rather than in a tool card (ToolView's inline attachment). Spec: 8 side
 * margins and 1 above and below; inside, padding 12/8 and 4 between the
 * picture and the name. The picture is [fileImageDisplaySize], radius 8,
 * left-aligned, cropped to fill, fading in over 150 ms once decrypted
 * (by the shared image loader);
 * before that the space is empty. If it can't be loaded, a 24 circle in
 * surfaceHigh sits 4 in from its top right with alert-circle-outline 20 in
 * textSecondary. The name: 13 medium textSecondary, one line. Nothing at
 * all when the input isn't a file event's.
 */
@Composable
fun FileMessageView(input: JsonElement?, modifier: Modifier = Modifier) {
    val file = remember(input) { FileToolInput.parse(input) } ?: return
    val attachments = LocalSessionAttachments.current
    val colors = HappyTheme.colors
    val (width, height) = fileImageDisplaySize(file.image)
    var bytes by remember(file.ref, attachments) { mutableStateOf<ByteArray?>(null) }
    var failed by remember(file.ref, attachments) { mutableStateOf(false) }
    LaunchedEffect(file.ref, attachments) {
        if (attachments == null) return@LaunchedEffect
        val loaded = try {
            attachments.cached(file.ref) ?: attachments.load(file.ref)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            null
        }
        bytes = loaded
        failed = loaded == null
    }

    Column(
        modifier = modifier
            .testTag(FileMessageTags.ROW)
            .fillMaxWidth()
            .padding(horizontal = FileMessageSpec.rowMarginHorizontal, vertical = FileMessageSpec.rowMarginVertical)
            .padding(horizontal = FileMessageSpec.paddingHorizontal, vertical = FileMessageSpec.paddingVertical),
        verticalArrangement = Arrangement.spacedBy(FileMessageSpec.gap),
    ) {
        Box(
            modifier = Modifier
                .size(width, height)
                .clip(RoundedCornerShape(FileMessageSpec.radius))
                .testTag(FileMessageTags.IMAGE),
        ) {
            bytes?.let {
                // The shared loader decodes it at the displayed size, once per ref.
                RemoteImage(
                    model = it,
                    contentDescription = file.name,
                    contentScale = ContentScale.Crop,
                    cacheKey = "attachment:${file.ref}",
                    modifier = Modifier.size(width, height),
                    onState = { state -> if (state == RemoteImageState.Error) failed = true },
                )
            }
            if (failed) {
                Box(
                    modifier = Modifier
                        .align(Alignment.TopEnd)
                        .padding(FileMessageSpec.errorInset)
                        .size(FileMessageSpec.errorSize)
                        .background(colors.surfaceHigh, CircleShape)
                        .testTag(FileMessageTags.ERROR),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(Ionicon.AlertCircleOutline, FileMessageSpec.errorIcon, colors.textSecondary)
                }
            }
        }
        Text(
            text = file.name,
            style = FileMessageSpec.filename,
            color = colors.textSecondary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.testTag(FileMessageTags.NAME),
        )
    }
}
