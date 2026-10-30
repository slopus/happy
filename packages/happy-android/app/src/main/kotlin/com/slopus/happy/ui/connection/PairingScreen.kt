package com.slopus.happy.ui.connection

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.connection.PairingState
import com.slopus.happy.ui.components.RoundButton
import com.slopus.happy.ui.components.RoundButtonDisplay
import com.slopus.happy.ui.components.Screen
import com.slopus.happy.ui.components.StackHeader
import com.slopus.happy.ui.layout.LocalWindowLayout
import com.slopus.happy.ui.layout.contentMaxWidth
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle

object PairingTags {
    const val SPINNER = "agentPairing.spinner"
    const val EMOJI = "agentPairing.emoji"
    const val MATCH = "agentPairing.match"
    const val MISMATCH = "agentPairing.mismatch"
    const val DONE = "agentPairing.done"
}

/**
 * Pairing an agent over Happy Protocol V2: the standard header (back
 * rejects an unfinished pairing), then by [state] a spinner while the keys
 * are exchanged, the four emoji at 40 with "They match" and "They don't
 * match", a spinner under the emoji while the agent confirms, the paired
 * agent with Done, or why it failed with Done. Centred column, 24 in
 * from the sides, 16 between parts.
 */
@Composable
fun PairingScreen(
    state: PairingState?,
    onConfirm: () -> Unit,
    onReject: () -> Unit,
    onBack: () -> Unit,
    onDone: () -> Unit,
) {
    val colors = HappyTheme.colors
    val title = happyTextStyle(fontSize = 20, lineHeight = 28, weight = FontWeight.SemiBold)
    val body = happyTextStyle(fontSize = 16, lineHeight = 24)
    val note = happyTextStyle(fontSize = 13, lineHeight = 18)
    Screen(header = { StackHeader(stringResource(R.string.pairing_title), onBack) }) {
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
            @Composable
            fun Line(text: String, style: androidx.compose.ui.text.TextStyle, secondary: Boolean = false) = Text(
                text,
                style = style,
                color = if (secondary) colors.textSecondary else colors.text,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth(),
            )

            @Composable
            fun Spinner() = CircularProgressIndicator(
                color = colors.textSecondary,
                strokeWidth = 2.dp,
                modifier = Modifier.size(24.dp).testTag(PairingTags.SPINNER),
            )

            @Composable
            fun Emoji(emoji: List<String>) = Row(
                horizontalArrangement = Arrangement.spacedBy(16.dp),
                modifier = Modifier
                    .testTag(PairingTags.EMOJI)
                    .semantics { contentDescription = emoji.joinToString(" ") },
            ) {
                emoji.forEach { Text(it, style = happyTextStyle(fontSize = 40, lineHeight = 52)) }
            }

            when (state) {
                null -> Spinner()
                is PairingState.Connecting -> {
                    Spinner()
                    Line(stringResource(R.string.pairing_connecting, state.agentName), body)
                    Line(stringResource(R.string.pairing_unverified), note, secondary = true)
                }
                is PairingState.Compare -> {
                    Emoji(state.emoji)
                    Line(stringResource(R.string.pairing_compare, state.agentName), body)
                    Spacer(Modifier.height(8.dp))
                    RoundButton(
                        stringResource(R.string.pairing_match),
                        onConfirm,
                        Modifier.testTag(PairingTags.MATCH),
                    )
                    RoundButton(
                        stringResource(R.string.pairing_mismatch),
                        onReject,
                        Modifier.testTag(PairingTags.MISMATCH),
                        display = RoundButtonDisplay.Inverted,
                    )
                }
                is PairingState.Confirming -> {
                    Emoji(state.emoji)
                    Spinner()
                    Line(stringResource(R.string.pairing_confirming, state.agentName), body)
                }
                is PairingState.Paired -> {
                    Line(stringResource(R.string.pairing_paired, state.account.name), title)
                    Line(stringResource(R.string.pairing_paired_detail), body, secondary = true)
                    Spacer(Modifier.height(8.dp))
                    RoundButton(stringResource(R.string.pairing_done), onDone, Modifier.testTag(PairingTags.DONE))
                }
                is PairingState.Failed -> {
                    Line(stringResource(R.string.pairing_failed), title)
                    Line(state.message, body, secondary = true)
                    Spacer(Modifier.height(8.dp))
                    RoundButton(stringResource(R.string.pairing_done), onDone, Modifier.testTag(PairingTags.DONE))
                }
            }
        }
    }
}
