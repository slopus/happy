package com.slopus.happy.ui.components

import android.graphics.BitmapFactory
import android.util.Base64
import android.util.LruCache
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
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
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.model.AvatarHarness
import com.slopus.happy.model.resolveAvatarHarness
import com.slopus.happy.ui.components.avatar.PlaceholderAvatar
import com.slopus.happy.ui.theme.HappyTheme
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlin.math.roundToInt

/**
 * The settings every avatar reads (`avatarMonochrome`, `showFlavorIcons`,
 * `showHarnessIconInSessionHeader`). `avatarStyle` is still synced but
 * changes nothing: as on happy-ios, every avatar without a picture wears its
 * placeholder whichever style is set.
 */
@Immutable
data class AvatarSettings(
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
 * Avatar.tsx as happy-ios's AvatarView draws it: a picture (a data URI
 * materialized by sync, a URL or a file) wins; without one, a person, bot,
 * task, chat or account wears the placeholder [id] picks
 * ([PlaceholderAvatar]), not happy-app's generated faces. While a picture
 * loads (a URL downloading, a data URI decoding) its [thumbhash] stands in
 * for it, cover-fit as expo-image draws one (Avatar.tsx `placeholder`), or
 * without one the still placeholder. The monochrome setting forces
 * black-and-white; a caller's [monochrome] (offline rows) also does. Where
 * [animated] (the default; the account menu's rows pass false, and an
 * account elsewhere only without a picture, `AvatarPlaceholder.liveSeed`) and
 * Animated Avatars is on, the placeholder moves.
 *
 * With [badgeLocation] opted in by the matching setting, a harness badge
 * sits bottom-right, 2 outside the avatar: a surface circle of
 * round(size × 0.42) with 2 padding and a soft shadow, holding the harness
 * icon (Happy 0.26, Codex 0.30, Claude 0.34, Antigravity 0.42 of size).
 * [bot] is kept for callers; a bot without a picture wears its placeholder
 * too, as on happy-ios.
 */
@Composable
fun Avatar(
    id: String,
    size: Dp,
    modifier: Modifier = Modifier,
    @Suppress("UNUSED_PARAMETER") bot: Boolean = false,
    square: Boolean = false,
    monochrome: Boolean = false,
    flavor: String? = null,
    clientId: String? = null,
    badgeLocation: AvatarBadgeLocation = AvatarBadgeLocation.None,
    imageUri: String? = null,
    thumbhash: String? = null,
    animated: Boolean = true,
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
        val image = imageUri?.takeUnless { isRemoteImageUrl(it) || isFileImageUri(it) }?.let { rememberDataUriImage(it) }
        val placeholder = if (imageUri != null && image == null) rememberThumbHash(thumbhash) else null
        when {
            isRemoteImageUrl(imageUri) || isFileImageUri(imageUri) -> RemoteImage(imageUri, null, Modifier.size(size).clip(shape), background = colors.surfaceHigh, placeholder = placeholder)
            imageUri != null && image != null -> Image(
                bitmap = image,
                contentDescription = null,
                contentScale = ContentScale.Crop,
                modifier = Modifier.size(size).clip(shape),
            )
            imageUri != null && placeholder != null -> Image(
                bitmap = placeholder,
                contentDescription = null,
                contentScale = ContentScale.Crop,
                modifier = Modifier.size(size).clip(shape).testTag(AvatarTags.PLACEHOLDER),
            )
            // A picture still decoding: its placeholder, still, under where it lands.
            imageUri != null -> PlaceholderAvatar(id, size, shape = shape, monochrome = mono, animated = false)
            else -> PlaceholderAvatar(id, size, shape = shape, monochrome = mono, animated = animated)
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

/** Decoded data-URI pictures, shared by every row: the list shows the same few many times. */
private val imageCache = LruCache<String, ImageBitmap>(64)

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

/**
 * A picture given as a data URI (project and session avatars are
 * materialized as `data:` URIs by sync), decoded off the main thread and
 * cached; null until it lands. Remote URLs go to [RemoteImage].
 */
@Composable
private fun rememberDataUriImage(uri: String): ImageBitmap? {
    var image by remember(uri) { mutableStateOf(imageCache.get(uri)) }
    if (image == null) {
        LaunchedEffect(uri) {
            image = withContext(Dispatchers.IO) { decodeDataUri(uri)?.also { imageCache.put(uri, it) } }
        }
    }
    return image
}
