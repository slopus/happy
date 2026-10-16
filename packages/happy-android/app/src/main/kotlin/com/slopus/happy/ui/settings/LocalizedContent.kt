package com.slopus.happy.ui.settings

import android.content.Context
import android.content.ContextWrapper
import android.content.res.Configuration
import android.content.res.Resources
import android.os.LocaleList
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalResources
import java.util.Locale

/**
 * [content] with resources in [locale]: a configuration override, so the
 * app's language applies on every API level without restarting the
 * activity. The context stays a wrapper of the real one, so code that looks
 * for the activity still finds it.
 */
@Composable
fun LocalizedContent(locale: Locale, content: @Composable () -> Unit) {
    val base = LocalContext.current
    val configuration = LocalConfiguration.current
    val localized = remember(base, configuration, locale) {
        val override = Configuration(configuration).apply { setLocales(LocaleList(locale)) }
        LocalizedContext(base, base.createConfigurationContext(override).resources, override)
    }
    CompositionLocalProvider(
        LocalContext provides localized,
        LocalConfiguration provides localized.configuration,
        LocalResources provides localized.resources,
        content = content,
    )
}

private class LocalizedContext(base: Context, private val localized: Resources, val configuration: Configuration) : ContextWrapper(base) {
    override fun getResources(): Resources = localized
}
