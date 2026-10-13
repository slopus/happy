package com.slopus.happy.ui.home

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.ui.components.Header
import com.slopus.happy.ui.components.HeaderIconButton
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.TitleAlignment
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle

object HomeTags {
    const val LOGO = "home.logo"
    const val SETTINGS = "home.settings"
    const val EMPTY = "home.empty"
}

/** HomeHeader.tsx / MainView.tsx */
object HomeSpec {
    val logoBox = 32.dp
    val logo = 19.dp
    val actionButton = 44.dp
    val actionIcon = 22.dp
    val emptyPadding = 32.dp
    val empty = happyTextStyle(fontSize = 15, lineHeight = 20)
}

/**
 * Signed in. The header is happy-app's phone home header: logo on the left
 * (19 in a 32 box, header tint), "Happy" centred, the settings gear (22 in
 * a 44 button) on the right. The session list is not built yet, so the body
 * is an empty state.
 */
@Composable
fun HomeScreen(onSettings: () -> Unit) {
    val colors = HappyTheme.colors
    Column(modifier = Modifier.fillMaxSize().background(colors.grouped.background)) {
        Header(
            title = stringResource(R.string.sidebar_sessions_title),
            alignment = TitleAlignment.Center,
            left = {
                Box(modifier = Modifier.size(HomeSpec.logoBox).testTag(HomeTags.LOGO), contentAlignment = Alignment.Center) {
                    Image(
                        painter = painterResource(R.drawable.happy_logo),
                        contentDescription = null,
                        contentScale = ContentScale.Fit,
                        colorFilter = ColorFilter.tint(colors.header.tint),
                        modifier = Modifier.size(HomeSpec.logo),
                    )
                }
            },
            right = {
                Box(modifier = Modifier.testTag(HomeTags.SETTINGS)) {
                    HeaderIconButton(
                        icon = Ionicon.SettingsOutline,
                        contentDescription = stringResource(R.string.settings_title),
                        onClick = onSettings,
                        iconSize = HomeSpec.actionIcon,
                        buttonSize = HomeSpec.actionButton,
                    )
                }
            },
        )
        Box(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth()
                .windowInsetsPadding(WindowInsets.navigationBars),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = stringResource(R.string.home_empty),
                style = HomeSpec.empty,
                color = colors.textSecondary,
                textAlign = TextAlign.Center,
                modifier = Modifier.padding(HomeSpec.emptyPadding).testTag(HomeTags.EMPTY),
            )
        }
    }
}
