package com.slopus.happy.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.Dp
import com.slopus.happy.ui.theme.HappyTheme

/**
 * A stack screen: the header, then the content on the grouped background,
 * kept clear of the navigation bar and the keyboard (RN's
 * KeyboardAvoidingView with `behavior="height"`).
 */
@Composable
fun Screen(
    header: @Composable () -> Unit,
    modifier: Modifier = Modifier,
    content: @Composable BoxScope.() -> Unit,
) {
    Column(modifier = modifier.fillMaxSize().background(HappyTheme.colors.grouped.background)) {
        header()
        Box(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth()
                .windowInsetsPadding(WindowInsets.navigationBars.union(WindowInsets.ime)),
            content = content,
        )
    }
}

/** A pushed screen's header: back arrow and title. */
@Composable
fun StackHeader(title: String, onBack: () -> Unit, alignment: TitleAlignment = TitleAlignment.Start) {
    Header(title = title, alignment = alignment, left = { HeaderBackButton(onClick = onBack) })
}

/**
 * The bare RN TextInput look the onboarding and server screens use: a filled,
 * rounded box with no outline or label.
 */
@Composable
fun HappyTextField(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    textStyle: TextStyle,
    contentPadding: PaddingValues,
    minHeight: Dp,
    cornerRadius: Dp,
    modifier: Modifier = Modifier,
    singleLine: Boolean = false,
    enabled: Boolean = true,
    keyboardOptions: KeyboardOptions = KeyboardOptions.Default,
) {
    val colors = HappyTheme.colors
    val style = textStyle.copy(color = colors.input.text)
    BasicTextField(
        value = value,
        onValueChange = onValueChange,
        modifier = modifier
            .fillMaxWidth()
            .defaultMinSize(minHeight = minHeight)
            .clip(RoundedCornerShape(cornerRadius))
            .background(colors.surfaceHigh),
        enabled = enabled,
        singleLine = singleLine,
        textStyle = style,
        cursorBrush = SolidColor(colors.text),
        keyboardOptions = keyboardOptions,
        decorationBox = { inner ->
            Box(modifier = Modifier.padding(contentPadding)) {
                if (value.isEmpty()) Text(text = placeholder, style = style.copy(color = colors.input.placeholder))
                inner()
            }
        },
    )
}
