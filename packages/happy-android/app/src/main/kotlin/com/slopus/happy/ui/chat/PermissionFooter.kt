package com.slopus.happy.ui.chat

import android.util.Log
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.slopus.happy.chat.PermissionAnswer
import com.slopus.happy.chat.PermissionStatus
import com.slopus.happy.chat.ToolPermission
import com.slopus.happy.chat.tools.PermissionChoice
import com.slopus.happy.chat.tools.PermissionOptionState
import com.slopus.happy.chat.tools.answeredChoice
import com.slopus.happy.chat.tools.permissionOptionState
import com.slopus.happy.chat.tools.permissionOptions
import com.slopus.happy.ui.layout.LocalWindowLayout
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import kotlin.math.roundToInt

object PermissionTags {
    const val FOOTER = "permission.footer"
    fun option(choice: PermissionChoice) = "permission.option.${choice.name}"
}

object PermissionSpec {
    val paddingHorizontal = 6.dp
    val paddingTop = 4.dp
    val paddingBottom = 8.dp
    val gap = 7.dp
    val buttonPaddingHorizontal = 10.dp
    val buttonPaddingVertical = 7.dp
    val buttonRadius = 7.dp
    val buttonMinHeight = 34.dp
    val ringRadius = 8.dp
    val ringWidth = 2.dp
    /** System font, as RN draws text without a family. */
    val text = happyTextStyle(fontSize = 14, lineHeight = 18, family = FontFamily.Default)
    val textEmphasis = happyTextStyle(fontSize = 14, lineHeight = 18, weight = FontWeight.Medium, family = FontFamily.Default)
    const val INACTIVE_OPACITY = 0.52f
    const val PRESSED_OPACITY = 0.7f
    val maxHeight = 260.dp
}

/**
 * Sends one permission answer; [mode] is the permission mode the composer
 * switches to once it is sent (null for none).
 */
typealias PermissionHandler = suspend (answer: PermissionAnswer, mode: String?) -> Unit

/**
 * PermissionFooter.tsx (phone): the answers to a tool's permission request
 * as a column of buttons 7 apart, stretched, padded 6 / 4 above / 8 below,
 * scrolling past min(260, 35% of the window). A button: padding 10/7,
 * radius 7, surface fill, 1 divider border, at least 34 high, its label
 * centred in 14/18 text (weight 500 while pending or when chosen, 1 line
 * for Yes, 2 for the rest). Once answered, the chosen one fills with
 * surfaceHighest and the others fade to 0.52. While its answer is sent a
 * 2-wide ring in the text colour pulses (0.18 to 0.52, 720 ms each way)
 * and every button is disabled.
 */
@Composable
fun PermissionFooter(
    permission: ToolPermission,
    toolName: String,
    toolInput: JsonElement?,
    flavor: String?,
    onAnswer: PermissionHandler,
    modifier: Modifier = Modifier,
) {
    val options = remember(permission, toolName, toolInput, flavor) { permissionOptions(permission, toolName, toolInput, flavor) }
    val answered = remember(permission, toolName, toolInput, flavor) { answeredChoice(permission, toolName, toolInput, flavor) }
    var loading by remember { mutableStateOf<PermissionChoice?>(null) }
    val scope = rememberCoroutineScope()
    val pending = permission.status == PermissionStatus.Pending
    // `Math.min(260, Math.round(windowHeight * 0.35))`, from the window the app is laid out in.
    val maxHeight = minOf(PermissionSpec.maxHeight, (LocalWindowLayout.current.height.value * 0.35f).roundToInt().dp)
    // `buttonContainer.alignItems`: a tablet hugs each button to its label at the trailing edge; a phone stretches them.
    val stretch = !LocalWindowLayout.current.isTablet
    Column(
        modifier = modifier
            .fillMaxWidth()
            .testTag(PermissionTags.FOOTER)
            .padding(start = PermissionSpec.paddingHorizontal, end = PermissionSpec.paddingHorizontal, top = PermissionSpec.paddingTop, bottom = PermissionSpec.paddingBottom)
            .heightIn(max = maxHeight)
            .verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(PermissionSpec.gap),
        horizontalAlignment = if (stretch) Alignment.Start else Alignment.End,
    ) {
        for (option in options) {
            PermissionButton(
                label = stringResource(option.label),
                state = permissionOptionState(option, permission, answered),
                maxLines = option.maxLines,
                loading = pending && loading == option.choice,
                enabled = pending && loading == null,
                stretch = stretch,
                modifier = Modifier.testTag(PermissionTags.option(option.choice)),
                onClick = {
                    loading = option.choice
                    scope.launch {
                        try {
                            onAnswer(option.answer, option.mode)
                        } catch (e: CancellationException) {
                            throw e
                        } catch (e: Exception) {
                            // happy-app logs a failed answer and leaves the request pending.
                            Log.w("PermissionFooter", "Failed to answer permission", e)
                        } finally {
                            loading = null
                        }
                    }
                },
            )
        }
    }
}

@Composable
private fun PermissionButton(
    label: String,
    state: PermissionOptionState,
    maxLines: Int,
    loading: Boolean,
    enabled: Boolean,
    stretch: Boolean,
    modifier: Modifier,
    onClick: () -> Unit,
) {
    val colors = HappyTheme.colors
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val shape = RoundedCornerShape(PermissionSpec.buttonRadius)
    val opacity = when {
        state == PermissionOptionState.Inactive -> PermissionSpec.INACTIVE_OPACITY
        pressed && state == PermissionOptionState.Pending -> PermissionSpec.PRESSED_OPACITY
        else -> 1f
    }
    Box(
        modifier = modifier
            .then(if (stretch) Modifier.fillMaxWidth() else Modifier)
            .alpha(opacity),
        contentAlignment = Alignment.Center,
    ) {
        Box(
            modifier = Modifier
                .then(if (stretch) Modifier.fillMaxWidth() else Modifier)
                .defaultMinSize(minHeight = PermissionSpec.buttonMinHeight)
                .clip(shape)
                .background(if (state == PermissionOptionState.Selected) colors.surfaceHighest else colors.surface)
                .border(1.dp, colors.divider, shape)
                .clickable(interactionSource = interaction, indication = null, enabled = enabled, role = Role.Button, onClick = onClick)
                .padding(horizontal = PermissionSpec.buttonPaddingHorizontal, vertical = PermissionSpec.buttonPaddingVertical),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = label,
                style = if (state == PermissionOptionState.Pending || state == PermissionOptionState.Selected) PermissionSpec.textEmphasis else PermissionSpec.text,
                color = colors.text,
                maxLines = maxLines,
                overflow = TextOverflow.Ellipsis,
                textAlign = TextAlign.Center,
            )
        }
        if (loading) {
            val pulse by rememberInfiniteTransition(label = "permissionRing").animateFloat(
                initialValue = 0.18f,
                targetValue = 0.52f,
                animationSpec = infiniteRepeatable(tween(720, easing = FastOutSlowInEasing), RepeatMode.Reverse),
                label = "permissionRingOpacity",
            )
            Box(
                modifier = Modifier
                    .matchParentSize()
                    .outset(1.dp)
                    .alpha(pulse)
                    .border(PermissionSpec.ringWidth, colors.text, RoundedCornerShape(PermissionSpec.ringRadius)),
            )
        }
    }
}
