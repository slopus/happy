package com.slopus.happy.ui.components

import com.slopus.happy.ui.tablet.BackOrSidebarToggle
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.RowScope
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
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.Dp
import com.slopus.happy.ui.theme.HappyTheme
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.IconButton
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.ui.layout.LocalWindowLayout
import com.slopus.happy.ui.layout.contentMaxWidth

/**
 * A stack screen: the header on glass over the content
 * ([GlassBarScreen]), on [ground] (the grouped background unless the page
 * is drawn on another), kept clear of the navigation bar. A list that
 * claims the header's room ([ItemList], [barInsetTop]) runs under it and
 * goes soft behind it; other content starts below it. Only a
 * screen with a text field of its own sets [avoidKeyboard] and shrinks above
 * the keyboard; the others stay put when a keyboard opens over them (a
 * dialog's, say).
 */
@Composable
fun Screen(
    header: @Composable () -> Unit,
    modifier: Modifier = Modifier,
    avoidKeyboard: Boolean = false,
    ground: Color = HappyTheme.colors.grouped.background,
    content: @Composable BoxScope.() -> Unit,
) {
    GlassBarScreen(header, ground, modifier.fillMaxSize().background(ground)) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .windowInsetsPadding(if (avoidKeyboard) WindowInsets.navigationBars.union(WindowInsets.ime) else WindowInsets.navigationBars),
            content = content,
        )
    }
}

/**
 * A pushed screen's header: back arrow and title. Start-aligned, it is the
 * Material top app bar every agent screen has (home's, its settings'): the
 * arrow in the navigation slot on the 16 keyline, the title in Material's
 * title large, [actions] at the end, held to the content width ([fullWidth]:
 * the window's, for a screen whose frame is the window's own). On a
 * [Screen] it is glass. [titleAlpha] is read while drawing, for a page
 * whose own large name fades the bar's title in as it scrolls under it.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun StackHeader(title: String, onBack: () -> Unit, titleAlpha: (() -> Float)? = null, fullWidth: Boolean = false, actions: @Composable RowScope.() -> Unit = {}) {
    val colors = HappyTheme.colors
    Box(Modifier.fillMaxWidth().then(if (LocalBarOnGlass.current) Modifier else Modifier.background(colors.grouped.background))) {
        TopAppBar(
            modifier = (if (fullWidth) Modifier.fillMaxWidth() else Modifier.contentMaxWidth(LocalWindowLayout.current)).testTag(HeaderTags.BAR),
            colors = TopAppBarDefaults.topAppBarColors(
                containerColor = Color.Transparent,
                scrolledContainerColor = Color.Transparent,
                navigationIconContentColor = colors.text,
                titleContentColor = colors.text,
                actionIconContentColor = colors.text,
            ),
            navigationIcon = {
                // The tablet main panel's root has the sidebar's toggle here instead.
                BackOrSidebarToggle {
                    IconButton(onClick = onBack, modifier = Modifier.testTag(HeaderTags.LEFT)) {
                        Icon(Ionicon.ArrowBack, 24.dp, LocalContentColor.current, contentDescription = stringResource(R.string.common_back))
                    }
                }
            },
            title = {
                Text(
                    title,
                    style = MaterialTheme.typography.titleLarge,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier
                        .testTag(HeaderTags.TITLE)
                        .semantics { heading() }
                        .then(if (titleAlpha != null) Modifier.graphicsLayer { alpha = titleAlpha() } else Modifier),
                )
            },
            actions = actions,
        )
    }
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
    keyboardActions: KeyboardActions = KeyboardActions.Default,
    /** Hides what is typed, for a value no one should read over a shoulder. */
    visualTransformation: VisualTransformation = VisualTransformation.None,
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
        keyboardActions = keyboardActions,
        visualTransformation = visualTransformation,
        decorationBox = { inner ->
            Box(modifier = Modifier.padding(contentPadding)) {
                // A one-line field's placeholder stays on its line at any text size, cut short rather than wrapped.
                if (value.isEmpty()) Text(text = placeholder, style = style.copy(color = colors.input.placeholder), maxLines = if (singleLine) 1 else Int.MAX_VALUE, overflow = TextOverflow.Ellipsis)
                inner()
            }
        },
    )
}

/** [HappyTextField] over a [TextFieldValue], for a field that places its own cursor (a prefilled one, at the end). */
@Composable
fun HappyTextField(
    value: TextFieldValue,
    onValueChange: (TextFieldValue) -> Unit,
    placeholder: String,
    textStyle: TextStyle,
    contentPadding: PaddingValues,
    minHeight: Dp,
    cornerRadius: Dp,
    modifier: Modifier = Modifier,
    singleLine: Boolean = false,
    enabled: Boolean = true,
    keyboardOptions: KeyboardOptions = KeyboardOptions.Default,
    keyboardActions: KeyboardActions = KeyboardActions.Default,
    visualTransformation: VisualTransformation = VisualTransformation.None,
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
        keyboardActions = keyboardActions,
        visualTransformation = visualTransformation,
        decorationBox = { inner ->
            Box(modifier = Modifier.padding(contentPadding)) {
                if (value.text.isEmpty()) Text(text = placeholder, style = style.copy(color = colors.input.placeholder), maxLines = if (singleLine) 1 else Int.MAX_VALUE, overflow = TextOverflow.Ellipsis)
                inner()
            }
        },
    )
}
