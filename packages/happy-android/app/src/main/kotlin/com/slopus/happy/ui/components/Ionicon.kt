package com.slopus.happy.ui.components

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.sp
import com.slopus.happy.R
import com.slopus.happy.ui.theme.RnLineHeightStyle

/**
 * The Ionicons glyphs happy-app uses, from the same icon font
 * (@expo/vector-icons 15.0.2, glyphmaps/Ionicons.json). Add entries as screens need them.
 */
enum class Ionicon(val codepoint: Int) {
    AddOutline(0xf107), // add-outline
    ArrowBack(0xf127), // arrow-back
    BugOutline(0xf1bb), // bug-outline
    Checkmark(0xf21d), // checkmark
    CheckmarkCircle(0xf21e), // checkmark-circle
    ChevronForward(0xf23b), // chevron-forward
    ColorPaletteOutline(0xf27e), // color-palette-outline
    ContrastOutline(0xf28d), // contrast-outline
    CopyOutline(0xf290), // copy-outline
    DocumentTextOutline(0xf2b4), // document-text-outline
    EllipseOutline(0xf2cc), // ellipse-outline
    EyeOffOutline(0xf2e8), // eye-off-outline
    EyeOutline(0xf2ea), // eye-outline
    HelpCircleOutline(0xf37e), // help-circle-outline
    InformationCircleOutline(0xf399), // information-circle-outline
    LogOutOutline(0xf3d1), // log-out-outline
    LogoGithub(0xf3f3), // logo-github
    PersonCircleOutline(0xf4aa), // person-circle-outline
    QrCodeOutline(0xf4fd), // qr-code-outline
    ServerOutline(0xf569), // server-outline
    SettingsOutline(0xf56c), // settings-outline
    ShieldCheckmarkOutline(0xf579), // shield-checkmark-outline
}

private val IoniconsFamily = FontFamily(Font(R.font.ionicons))

/**
 * One glyph in a [size] x [size] box, like `<Ionicons size={size} />`. Unlike
 * RN text, the glyph does not grow with the system font scale: every icon
 * here sits in a fixed-size slot.
 */
@Composable
fun Icon(
    icon: Ionicon,
    size: Dp,
    color: Color,
    modifier: Modifier = Modifier,
    contentDescription: String? = null,
) {
    val fontSize = with(LocalDensity.current) { (size.value / fontScale).sp }
    Box(
        modifier = modifier
            .size(size)
            .then(if (contentDescription != null) Modifier.semantics { this.contentDescription = contentDescription } else Modifier),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = String(Character.toChars(icon.codepoint)),
            style = TextStyle(
                fontFamily = IoniconsFamily,
                fontSize = fontSize,
                lineHeight = fontSize,
                lineHeightStyle = RnLineHeightStyle,
                color = color,
            ),
            maxLines = 1,
            softWrap = false,
        )
    }
}
