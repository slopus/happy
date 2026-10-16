package com.slopus.happy.ui.components

import android.content.Context
import android.graphics.BitmapFactory
import android.util.Base64
import android.util.LruCache
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.ColorMatrix
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.model.AvatarHarness
import com.slopus.happy.model.resolveAvatarHarness
import com.slopus.happy.ui.theme.HappyTheme
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlin.math.abs
import kotlin.math.roundToInt

/** utils/avatarStyle.ts: the synced setting is a free string, so every read normalizes it. */
enum class AvatarStyle(val key: String) {
    Brutalist("brutalist"),
    Pixelated("pixelated"),
    Gradient("gradient");

    companion object {
        fun normalize(value: String?): AvatarStyle = entries.find { it.key == value } ?: Brutalist
    }
}

/** The settings every avatar reads (`avatarStyle`, `avatarMonochrome`, `showFlavorIcons`, `showHarnessIconInSessionHeader`). */
@Immutable
data class AvatarSettings(
    val style: AvatarStyle = AvatarStyle.Brutalist,
    val monochrome: Boolean = false,
    val showFlavorIcons: Boolean = false,
    val showHarnessIconInSessionHeader: Boolean = true,
)

val LocalAvatarSettings = staticCompositionLocalOf { AvatarSettings() }

enum class AvatarBadgeLocation { SessionHeader, SessionList, None }

object AvatarTags {
    const val AVATAR = "avatar"
    const val BADGE = "avatar.badge"
    const val PLACEHOLDER = "avatar.placeholder"
}

/** Avatar.tsx `harnessBadgeSizes`: one badge geometry for every place an avatar carries a harness icon. */
internal fun harnessBadgeSizes(size: Int, harness: AvatarHarness): Pair<Int, Int> {
    val circle = (size * 0.42).roundToInt()
    val icon = when (harness) {
        AvatarHarness.Rig -> (size * 0.26).roundToInt()
        AvatarHarness.Codex -> (size * 0.3).roundToInt()
        AvatarHarness.Claude -> (size * 0.34).roundToInt()
        AvatarHarness.Agy -> (size * 0.42).roundToInt()
    }
    return circle to icon
}

/**
 * Avatar.tsx. A bot without a picture is a chip on a surface circle; a
 * picture (a data URI materialized by sync) wins over a generated avatar;
 * otherwise the style setting picks brutalist, pixelated or gradient art,
 * chosen deterministically from [id]. While a picture loads (a URL
 * downloading, a data URI decoding) its [thumbhash] stands in for it,
 * cover-fit as expo-image draws one (Avatar.tsx `placeholder`). The
 * monochrome setting forces black-and-white; a caller's [monochrome]
 * (offline rows) also does.
 *
 * With [badgeLocation] opted in by the matching setting, a harness badge
 * sits bottom-right, 2 outside the avatar: a surface circle of
 * round(size × 0.42) with 2 padding and a soft shadow, holding the harness
 * icon (Happy 0.26, Codex 0.30, Claude 0.34, Antigravity 0.42 of size).
 */
@Composable
fun Avatar(
    id: String,
    size: Dp,
    modifier: Modifier = Modifier,
    bot: Boolean = false,
    square: Boolean = false,
    monochrome: Boolean = false,
    flavor: String? = null,
    clientId: String? = null,
    badgeLocation: AvatarBadgeLocation = AvatarBadgeLocation.None,
    imageUri: String? = null,
    thumbhash: String? = null,
) {
    val settings = LocalAvatarSettings.current
    val colors = HappyTheme.colors
    val mono = monochrome || settings.monochrome
    val showHarness = when (badgeLocation) {
        AvatarBadgeLocation.SessionHeader -> settings.showHarnessIconInSessionHeader
        AvatarBadgeLocation.SessionList -> settings.showFlavorIcons
        AvatarBadgeLocation.None -> false
    }
    val harness = resolveAvatarHarness(flavor, clientId)
    val shape = if (square) RectangleShape else CircleShape

    Box(modifier = modifier.size(size).testTag(AvatarTags.AVATAR)) {
        val image = imageUri?.takeUnless(::isRemoteImageUrl)?.let { rememberDataUriImage(it) }
        val placeholder = if (imageUri != null && image == null) rememberThumbHash(thumbhash) else null
        when {
            isRemoteImageUrl(imageUri) -> RemoteImage(imageUri, null, Modifier.size(size).clip(shape), background = colors.surfaceHigh, placeholder = placeholder)
            imageUri != null && image != null -> Image(
                bitmap = image,
                contentDescription = null,
                contentScale = ContentScale.Crop,
                modifier = Modifier.size(size).clip(shape),
            )
            bot && imageUri == null -> Box(
                modifier = Modifier.size(size).clip(CircleShape).background(colors.surface),
                contentAlignment = Alignment.Center,
            ) {
                Icon(Ionicon.HardwareChipOutline, (size.value * 0.55f).roundToInt().dp, if (mono) colors.textSecondary else colors.text)
            }
            imageUri != null && placeholder != null -> Image(
                bitmap = placeholder,
                contentDescription = null,
                contentScale = ContentScale.Crop,
                modifier = Modifier.size(size).clip(shape).testTag(AvatarTags.PLACEHOLDER),
            )
            imageUri != null -> Box(Modifier.size(size).clip(shape).background(colors.surfaceHigh))
            settings.style == AvatarStyle.Pixelated -> AvatarPixelated(id, size, square, mono)
            settings.style == AvatarStyle.Gradient -> AvatarGradient(id, size, square, mono)
            else -> AvatarBrutalist(id, size, square, mono)
        }
        if (showHarness && harness != null) {
            val (circle, icon) = harnessBadgeSizes(size.value.roundToInt(), harness)
            Box(
                modifier = Modifier
                    .align(Alignment.BottomEnd)
                    .offset(2.dp, 2.dp)
                    .size(circle.dp)
                    .testTag(AvatarTags.BADGE)
                    .shadow(3.dp, CircleShape)
                    .background(colors.surface, CircleShape)
                    .padding(2.dp),
                contentAlignment = Alignment.Center,
            ) {
                Image(
                    painter = painterResource(
                        when (harness) {
                            AvatarHarness.Claude -> R.drawable.icon_claude
                            AvatarHarness.Codex -> R.drawable.icon_gpt
                            AvatarHarness.Agy -> R.drawable.icon_agy
                            AvatarHarness.Rig -> R.drawable.happy_logo
                        },
                    ),
                    contentDescription = null,
                    contentScale = ContentScale.Fit,
                    colorFilter = if (harness == AvatarHarness.Codex || harness == AvatarHarness.Rig) ColorFilter.tint(colors.text) else null,
                    modifier = Modifier.size(icon.dp),
                )
            }
        }
    }
}

/** The `hashCode` all three generated styles share: JS's 31-hash over UTF-16 units, in int32, then Math.abs. */
fun avatarHash(value: String): Long {
    var hash = 0
    for (char in value) hash = (hash shl 5) - hash + char.code
    return abs(hash.toLong())
}

/** AvatarBrutalist.tsx: the art lists in their order, so an id picks the image happy-app picks. */
object BrutalistArt {
    val images: List<String> = (1..262).map { "Abstract-$it" } + (1..40).map { "Bauhaus-$it" } + (1..118).map { "Brutalism-$it" }

    /** tint over background. */
    val colorPairs = listOf(
        Color(0xFFFFA617) to Color(0xFF0056B3),
        Color(0xFF59C9DF) to Color(0xFFDC2626),
        Color(0xFFC678FF) to Color(0xFF16A34A),
        Color(0xFFFF79D7) to Color(0xFF047857),
        Color(0xFFFFD800) to Color(0xFF4C1D95),
        Color(0xFF84E600) to Color(0xFFC026D3),
    )

    fun imageFor(id: String): String = images[(avatarHash(id) % images.size).toInt()]
    fun colorsFor(id: String): Pair<Color, Color> = colorPairs[(avatarHash(id + "color") % colorPairs.size).toInt()]
}

/**
 * AvatarBrutalist.tsx: a shape from the art set, tinted, at 80% on a coloured
 * circle. Monochrome: #999999 on #F0F0F0.
 */
@Composable
fun AvatarBrutalist(id: String, size: Dp, square: Boolean = false, monochrome: Boolean = false) {
    val (tint, background) = if (monochrome) Color(0xFF999999) to Color(0xFFF0F0F0) else BrutalistArt.colorsFor(id)
    val shape = if (square) RectangleShape else RoundedCornerShape(size / 2)
    Box(modifier = Modifier.size(size).clip(shape).background(background), contentAlignment = Alignment.Center) {
        val image = rememberAssetImage("avatars/brutalist/${BrutalistArt.imageFor(id)}.png")
        if (image != null) {
            Image(
                bitmap = image,
                contentDescription = null,
                colorFilter = ColorFilter.tint(tint),
                modifier = Modifier.size(size * 0.8f).clip(shape),
            )
        }
    }
}

/**
 * AvatarGradient.tsx: one of 100 gradients, cover-fit. Monochrome drains the
 * colour but keeps its light, as the saturation blend does.
 */
@Composable
fun AvatarGradient(id: String, size: Dp, square: Boolean = false, monochrome: Boolean = false) {
    val index = (avatarHash(id) % 100).toInt() + 1
    val image = rememberAssetImage("avatars/gradients/%02d.png".format(index))
    val shape = if (square) RectangleShape else RoundedCornerShape(size / 2)
    Box(modifier = Modifier.size(size).clip(shape)) {
        if (image != null) {
            Image(
                bitmap = image,
                contentDescription = null,
                contentScale = ContentScale.Crop,
                colorFilter = if (monochrome) ColorFilter.colorMatrix(ColorMatrix().apply { setToSaturation(0f) }) else null,
                modifier = Modifier.size(size),
            )
        }
    }
}

/** AvatarSkia.tsx: an 8x8 grid, cell i coloured `palette[hash % (i + 1) % 5]`. */
object PixelatedArt {
    val colors = listOf(Color(0xFF0A0310), Color(0xFF49007E), Color(0xFFFF005B), Color(0xFFFF7D10), Color(0xFFFFB238))
    val grayscale = listOf(Color(0xFF070707), Color(0xFF242424), Color(0xFF575757), Color(0xFF979797), Color(0xFFBBBBBB))

    fun cells(id: String, monochrome: Boolean): List<Color> {
        val palette = if (monochrome) grayscale else colors
        val hash = avatarHash(id)
        return List(64) { i -> palette[((hash % (i + 1)) % palette.size).toInt()] }
    }
}

@Composable
fun AvatarPixelated(id: String, size: Dp, square: Boolean = false, monochrome: Boolean = false) {
    val cells = remember(id, monochrome) { PixelatedArt.cells(id, monochrome) }
    val shape = if (square) RectangleShape else CircleShape
    Canvas(modifier = Modifier.size(size).clip(shape)) {
        val cell = this.size.width / 8f
        cells.forEachIndexed { i, color ->
            drawRect(color, topLeft = Offset((i % 8) * cell, (i / 8) * cell), size = Size(cell, cell))
        }
    }
}

/** Decoded avatar art, shared by every row: the list shows the same few images many times. */
private val imageCache = LruCache<String, ImageBitmap>(160)

private fun loadAsset(context: Context, path: String): ImageBitmap? = try {
    context.assets.open(path).use { BitmapFactory.decodeStream(it)?.asImageBitmap() }
} catch (_: java.io.IOException) {
    null
}

private fun decodeDataUri(uri: String): ImageBitmap? {
    if (!uri.startsWith("data:")) return null
    val comma = uri.indexOf(',')
    if (comma < 0 || !uri.substring(0, comma).endsWith(";base64")) return null
    return try {
        val bytes = Base64.decode(uri.substring(comma + 1), Base64.DEFAULT)
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap()
    } catch (_: IllegalArgumentException) {
        null
    }
}

/** An image decoded off the main thread and cached; null until it lands. */
@Composable
private fun rememberCachedImage(key: String, load: () -> ImageBitmap?): ImageBitmap? {
    var image by remember(key) { mutableStateOf(imageCache.get(key)) }
    if (image == null) {
        LaunchedEffect(key) {
            image = withContext(Dispatchers.IO) { load()?.also { imageCache.put(key, it) } }
        }
    }
    return image
}

@Composable
private fun rememberAssetImage(path: String): ImageBitmap? {
    val context = LocalContext.current.applicationContext
    return rememberCachedImage(path) { loadAsset(context, path) }
}

/**
 * A picture given as a data URI (project and session avatars are
 * materialized as `data:` URIs by sync). Remote URLs go to [RemoteImage].
 */
@Composable
private fun rememberDataUriImage(uri: String): ImageBitmap? = rememberCachedImage(uri) { decodeDataUri(uri) }
