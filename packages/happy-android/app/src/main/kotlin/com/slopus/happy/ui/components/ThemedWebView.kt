package com.slopus.happy.ui.components

import android.content.Context
import android.webkit.WebView
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import com.slopus.happy.ui.theme.withNightMode

/**
 * A WebView in the app's theme from its first frame, not WebView's white.
 * Its context has the app's night mode ([withNightMode]), which a page sees
 * as `prefers-color-scheme`; [prepare] runs before anything else touches it
 * (a profile is fixed at first use); [background] shows until the page
 * paints, and wherever a page leaves its own background transparent.
 */
fun themedWebView(context: Context, background: Color, dark: Boolean, prepare: WebView.() -> Unit = {}): WebView =
    WebView(context.withNightMode(dark)).apply {
        prepare()
        setBackgroundColor(background.toArgb())
    }
