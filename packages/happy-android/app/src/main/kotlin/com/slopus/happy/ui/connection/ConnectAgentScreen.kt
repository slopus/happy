package com.slopus.happy.ui.connection

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.components.RoundButton
import com.slopus.happy.ui.components.RoundButtonDisplay
import com.slopus.happy.ui.components.Screen
import com.slopus.happy.ui.components.StackHeader
import com.slopus.happy.ui.layout.LocalWindowLayout
import com.slopus.happy.ui.layout.contentMaxWidth
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle

object ConnectAgentTags {
    const val SCAN = "connectAgent.scan"
    const val PASTE = "connectAgent.paste"
}

/**
 * Connect Agent, from Home's account menu or Welcome: says where the code
 * is, then "Scan QR Code" and "Enter Link Manually". Either one opens the
 * pairing screen. Same column as [PairingScreen].
 */
@Composable
fun ConnectAgentScreen(onScan: () -> Unit, onPaste: () -> Unit, onBack: () -> Unit, scanning: Boolean = false) {
    val colors = HappyTheme.colors
    Screen(header = { StackHeader(stringResource(R.string.connect_agent_title), onBack) }) {
        Column(
            modifier = Modifier
                .align(Alignment.TopCenter)
                .contentMaxWidth(LocalWindowLayout.current)
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 24.dp, vertical = 32.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Icon(Ionicon.QrCodeOutline, 64.dp, colors.textSecondary)
            Text(
                stringResource(R.string.connect_agent_body),
                style = happyTextStyle(fontSize = 16, lineHeight = 24),
                color = colors.text,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(8.dp))
            RoundButton(stringResource(R.string.connect_agent_scan), onScan, Modifier.testTag(ConnectAgentTags.SCAN), loading = scanning)
            RoundButton(
                stringResource(R.string.connect_agent_paste),
                onPaste,
                Modifier.testTag(ConnectAgentTags.PASTE),
                display = RoundButtonDisplay.Inverted,
            )
        }
    }
}
