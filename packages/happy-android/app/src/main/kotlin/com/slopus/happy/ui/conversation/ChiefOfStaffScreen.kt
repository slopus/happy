package com.slopus.happy.ui.conversation

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
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
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import com.slopus.happy.R
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.MaterialSymbols
import com.slopus.happy.ui.components.StateArt
import com.slopus.happy.ui.components.StatePage
import com.slopus.happy.ui.theme.HappyTheme

object ChiefOfStaffTags {
    const val SCREEN = "conversation.chief"
    const val LOADING = "conversation.chief.loading"
}

/**
 * While the Chief of Staff is looked up: the conversation's top app bar
 * titled "Chief of Staff" over a centred spinner, or, when it can't be
 * found, why, with Retry.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChiefOfStaffScreen(problem: String?, onRetry: () -> Unit, onBack: () -> Unit) {
    val colors = HappyTheme.colors
    Column(Modifier.fillMaxSize().background(colors.surface).testTag(ChiefOfStaffTags.SCREEN)) {
        TopAppBar(
            title = { Text(stringResource(R.string.conversation_chief_of_staff)) },
            navigationIcon = {
                IconButton(onClick = onBack, modifier = Modifier.testTag(ConversationScreenTags.BACK)) {
                    Icon(MaterialSymbols.ArrowBack, stringResource(R.string.conversation_back))
                }
            },
            colors = TopAppBarDefaults.topAppBarColors(
                containerColor = colors.surface,
                scrolledContainerColor = colors.surface,
                titleContentColor = colors.text,
                navigationIconContentColor = colors.text,
            ),
        )
        Box(Modifier.weight(1f).fillMaxWidth().windowInsetsPadding(WindowInsets.navigationBars)) {
            if (problem == null) {
                StatePage(title = null, body = null, art = StateArt.Waiting, tag = ChiefOfStaffTags.LOADING)
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
