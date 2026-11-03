package com.slopus.happy.ui.conversation

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import com.slopus.happy.R
import com.slopus.happy.ui.components.GlassBarScreen
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.MaterialSymbols
import com.slopus.happy.ui.components.FadeContent
import com.slopus.happy.ui.components.LoadingIndicator
import com.slopus.happy.ui.components.StatePage
import com.slopus.happy.ui.layout.LocalWindowLayout
import com.slopus.happy.ui.layout.contentMaxWidth
import com.slopus.happy.ui.theme.HappyTheme

object ChiefOfStaffTags {
    const val SCREEN = "conversation.chief"
    const val LOADING = "conversation.chief.loading"
}

/**
 * While the Chief of Staff is looked up: the conversation's top app bar
 * titled with its [name] as the computer calls it (desktop ca4c303f),
 * "Chief of Staff" until that is known, on glass ([GlassBarScreen]), over
 * a centred spinner, or, when it can't be found, why, with Retry.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChiefOfStaffScreen(problem: String?, onRetry: () -> Unit, onBack: () -> Unit, name: String? = null) {
    val colors = HappyTheme.colors
    GlassBarScreen(
        modifier = Modifier.fillMaxSize().background(colors.surface).testTag(ChiefOfStaffTags.SCREEN),
        ground = colors.surface,
        bar = {
            TopAppBar(
                title = { Text(name ?: stringResource(R.string.conversation_chief_of_staff), maxLines = 1, overflow = TextOverflow.Ellipsis) },
                navigationIcon = {
                    IconButton(onClick = onBack, modifier = Modifier.testTag(ConversationScreenTags.BACK)) {
                        Icon(MaterialSymbols.ArrowBack, stringResource(R.string.common_back))
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = Color.Transparent,
                    scrolledContainerColor = Color.Transparent,
                    titleContentColor = colors.text,
                    navigationIconContentColor = colors.text,
                ),
                modifier = Modifier.contentMaxWidth(LocalWindowLayout.current),
            )
        },
    ) {
        Box(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.navigationBars)) {
            FadeContent(problem, key = { it == null }) { problem ->
                if (problem == null) {
                    LoadingIndicator(Modifier.testTag(ChiefOfStaffTags.LOADING))
                } else {
                    StatePage(
                        title = stringResource(R.string.conversation_chief_unavailable),
                        body = problem,
                        icon = Ionicon.CloudOfflineOutline,
                        action = stringResource(R.string.common_retry) to onRetry,
                        tag = ConversationScreenTags.ERROR,
                    )
                }
            }
        }
    }
}
