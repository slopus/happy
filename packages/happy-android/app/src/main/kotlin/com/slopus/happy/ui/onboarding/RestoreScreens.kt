package com.slopus.happy.ui.onboarding

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.ui.components.HappyTextField
import com.slopus.happy.ui.connect.QrCode
import com.slopus.happy.ui.components.RoundButton
import com.slopus.happy.ui.components.RoundButtonDisplay
import com.slopus.happy.ui.components.RoundButtonSize
import com.slopus.happy.ui.components.Screen
import com.slopus.happy.ui.components.StackHeader
import com.slopus.happy.ui.components.TitleAlignment
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.PlexMono
import com.slopus.happy.ui.theme.happyTextStyle

object RestoreTags {
    const val INSTRUCTION = "restore.instruction"
    const val PATH = "restore.path"
    const val QR_SLOT = "restore.qrSlot"
    const val QR_FRAME = "restore.qrFrame"
    const val QR_CODE = "restore.qrCode"
    const val USE_KEY = "restore.useKey"
    const val KEY_INPUT = "restore.keyInput"
    const val KEY_BODY = "restore.keyBody"
}

/** restore/index.tsx and restore/manual.tsx */
object RestoreSpec {
    val paddingHorizontal = 32.dp
    val paddingVertical = 24.dp
    val instructionGap = 8.dp
    val pathGap = 32.dp
    val qrSize = 260.dp
    val qrRadius = 16.dp
    val qrFramePadding = 12.dp
    val spinner = 20.dp
    val buttonWidth = 280.dp
    val buttonGap = 32.dp
    val instruction = happyTextStyle(fontSize = 17, lineHeight = 22)
    val path = happyTextStyle(fontSize = 15, lineHeight = 20)

    val manualPaddingHorizontal = 24.dp
    val manualPaddingVertical = 24.dp
    val bodyGap = 20.dp
    val inputPadding = 16.dp
    val inputRadius = 12.dp
    val inputMinHeight = 120.dp
    val inputGap = 24.dp
    val input = happyTextStyle(fontSize = 15, lineHeight = 22, family = PlexMono)
}

/**
 * Restore by linking from a phone that already has the account
 * (restore/index.tsx). The other phone scans the code shown here; this one
 * waits for its answer (see [com.slopus.happy.auth.AccountLinkRequest]).
 *
 * Spec: centred column, 32/24 padding; instruction 17/22, 8 above the path
 * 15/20 secondary, 32 above the code. Until the request is registered
 * ([qrUrl] null) a 260 square, radius 16, surfaceHigh, holds a small
 * spinner; then the 260 code sits in a white frame with 12 padding and
 * radius 16. A 280 wide quiet button 32 below.
 */
@Composable
fun RestoreScreen(qrUrl: String?, onBack: () -> Unit, onUseSecretKey: () -> Unit) {
    val colors = HappyTheme.colors
    Screen(header = { StackHeader(stringResource(R.string.onboarding_restore_title), onBack, TitleAlignment.Center) }) {
        BoxWithConstraints {
            val viewport = maxHeight
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState())
                    .heightIn(min = viewport)
                    .padding(horizontal = RestoreSpec.paddingHorizontal, vertical = RestoreSpec.paddingVertical),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
            ) {
                Text(
                    text = stringResource(R.string.onboarding_restore_scan),
                    style = RestoreSpec.instruction,
                    color = colors.text,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.padding(bottom = RestoreSpec.instructionGap).testTag(RestoreTags.INSTRUCTION),
                )
                Text(
                    text = stringResource(R.string.onboarding_restore_scan_path),
                    style = RestoreSpec.path,
                    color = colors.textSecondary,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.padding(bottom = RestoreSpec.pathGap).testTag(RestoreTags.PATH),
                )
                if (qrUrl == null) {
                    Box(
                        modifier = Modifier
                            .size(RestoreSpec.qrSize)
                            .testTag(RestoreTags.QR_SLOT)
                            .clip(RoundedCornerShape(RestoreSpec.qrRadius))
                            .background(colors.surfaceHigh),
                        contentAlignment = Alignment.Center,
                    ) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(RestoreSpec.spinner),
                            color = colors.text,
                            strokeWidth = 2.dp,
                        )
                    }
                } else {
                    Box(
                        modifier = Modifier
                            .testTag(RestoreTags.QR_FRAME)
                            .clip(RoundedCornerShape(RestoreSpec.qrRadius))
                            .background(Color.White)
                            .padding(RestoreSpec.qrFramePadding),
                    ) {
                        QrCode(data = qrUrl, size = RestoreSpec.qrSize, modifier = Modifier.testTag(RestoreTags.QR_CODE))
                    }
                }
                Box(
                    modifier = Modifier
                        .padding(top = RestoreSpec.buttonGap)
                        .widthIn(max = RestoreSpec.buttonWidth)
                        .fillMaxWidth()
                        .testTag(RestoreTags.USE_KEY),
                ) {
                    RoundButton(
                        title = stringResource(R.string.onboarding_restore_use_key),
                        onClick = onUseSecretKey,
                        size = RoundButtonSize.Normal,
                        display = RoundButtonDisplay.Inverted,
                    )
                }
            }
        }
    }
}

/**
 * Restore with the secret key. Spec: 24 side padding, 24 above and below;
 * body 17/22 secondary, 20 above the input; input mono 15/22, 16 padding,
 * radius 12, at least 120 high, surfaceHigh, 24 above the large Restore
 * button. The input takes focus on open.
 */
@Composable
fun RestoreManualScreen(
    secretKey: String,
    onSecretKeyChange: (String) -> Unit,
    restoring: Boolean,
    onRestore: () -> Unit,
    onBack: () -> Unit,
    autoFocus: Boolean = true,
) {
    val colors = HappyTheme.colors
    val focusRequester = remember { FocusRequester() }
    if (autoFocus) LaunchedEffect(Unit) { focusRequester.requestFocus() }

    Screen(header = { StackHeader(stringResource(R.string.onboarding_secret_key_title), onBack, TitleAlignment.Center) }) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = RestoreSpec.manualPaddingHorizontal, vertical = RestoreSpec.manualPaddingVertical),
        ) {
            Text(
                text = stringResource(R.string.onboarding_secret_key_body),
                style = RestoreSpec.instruction,
                color = colors.textSecondary,
                modifier = Modifier.padding(bottom = RestoreSpec.bodyGap).testTag(RestoreTags.KEY_BODY),
            )
            HappyTextField(
                value = secretKey,
                onValueChange = onSecretKeyChange,
                placeholder = "XXXXX-XXXXX-XXXXX...",
                textStyle = RestoreSpec.input,
                contentPadding = PaddingValues(RestoreSpec.inputPadding),
                minHeight = RestoreSpec.inputMinHeight,
                cornerRadius = RestoreSpec.inputRadius,
                enabled = !restoring,
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters, autoCorrectEnabled = false),
                modifier = Modifier
                    .padding(bottom = RestoreSpec.inputGap)
                    .focusRequester(focusRequester)
                    .testTag(RestoreTags.KEY_INPUT),
            )
            RoundButton(title = stringResource(R.string.onboarding_restore_button), onClick = onRestore, loading = restoring)
        }
    }
}
