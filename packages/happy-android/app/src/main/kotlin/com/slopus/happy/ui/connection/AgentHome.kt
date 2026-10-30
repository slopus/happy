package com.slopus.happy.ui.connection

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.slopus.happy.AppGraph
import com.slopus.happy.R
import com.slopus.happy.connection.AgentConnectionException
import com.slopus.happy.connection.AgentIdentity
import com.slopus.happy.connection.AgentInfo
import com.slopus.happy.connection.TailcatTransport
import com.slopus.happy.ui.components.Header
import com.slopus.happy.ui.components.Screen
import com.slopus.happy.ui.components.TitleAlignment
import com.slopus.happy.ui.home.AccountMenu
import com.slopus.happy.ui.home.AccountMenuButton
import com.slopus.happy.ui.home.rememberAccountMenu
import com.slopus.happy.ui.layout.LocalWindowLayout
import com.slopus.happy.ui.layout.contentMaxWidth
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle
import kotlinx.coroutines.CancellationException

/** Where the open agent connection stands. */
@Immutable
sealed interface AgentReach {
    data object Connecting : AgentReach
    data class Connected(val info: AgentInfo) : AgentReach
    data class Failed(val message: String) : AgentReach
}

object AgentHomeTags {
    const val SPINNER = "agentHome.spinner"
    const val STATUS = "agentHome.status"
}

/**
 * Home while an agent connection is open: the standard top bar with the
 * account menu, then where the connection stands.
 */
@Composable
fun AgentHomeScreen(
    name: String,
    reach: AgentReach,
    accounts: AccountMenu,
    onSwitchAccount: (String) -> Unit,
) {
    val colors = HappyTheme.colors
    Screen(
        header = {
            Header(
                title = name,
                alignment = TitleAlignment.Center,
                left = { AccountMenuButton(accounts, onSwitchAccount) },
            )
        },
    ) {
        Column(
            modifier = Modifier
                .align(Alignment.TopCenter)
                .contentMaxWidth(LocalWindowLayout.current)
                .fillMaxWidth()
                .padding(horizontal = 24.dp, vertical = 32.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            val body = happyTextStyle(fontSize = 16, lineHeight = 24)
            when (reach) {
                AgentReach.Connecting -> CircularProgressIndicator(
                    color = colors.textSecondary,
                    strokeWidth = 2.dp,
                    modifier = Modifier.size(24.dp).testTag(AgentHomeTags.SPINNER),
                )
                is AgentReach.Connected -> Text(
                    stringResource(R.string.agent_home_connected, reach.info.name),
                    style = happyTextStyle(fontSize = 17, lineHeight = 24, weight = FontWeight.SemiBold),
                    color = colors.text,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.testTag(AgentHomeTags.STATUS),
                )
                is AgentReach.Failed -> Text(
                    reach.message,
                    style = body,
                    color = colors.textSecondary,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.testTag(AgentHomeTags.STATUS),
                )
            }
        }
    }
}

/** [AgentHomeScreen] for the agent connection [id]: reads its identity over Tailcat. */
@Composable
fun AgentHome(graph: AppGraph, id: String) {
    val agents by graph.agentConnections.accounts.collectAsStateWithLifecycle()
    val agent = agents.firstOrNull { it.id == id }
    val reach by produceState<AgentReach>(AgentReach.Connecting, id) {
        value = try {
            val credentials = graph.agentConnections.credentials(id) ?: throw AgentConnectionException(AgentConnectionException.Reason.Revoked)
            val transport = TailcatTransport(credentials.address, credentials.port)
            try {
                val info = AgentIdentity.refresh(transport, credentials.deviceToken, agent?.name.orEmpty())
                graph.agentConnections.update(id) { it.copy(name = info.name, thumbhash = info.thumbhash ?: it.thumbhash, revoked = false) }
                AgentReach.Connected(info)
            } finally {
                transport.close()
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: AgentConnectionException) {
            android.util.Log.w("AgentHome", "Connection failed: " + generateSequence<Throwable>(e) { it.cause }.joinToString(" <- ") { it.javaClass.name })
            if (e.reason == AgentConnectionException.Reason.Revoked) graph.agentConnections.update(id) { it.copy(revoked = true) }
            AgentReach.Failed(e.message.orEmpty())
        } catch (e: Exception) {
            android.util.Log.w("AgentHome", "Connection failed: " + generateSequence<Throwable>(e) { it.cause }.joinToString(" <- ") { it.javaClass.name })
            AgentReach.Failed(AgentConnectionException.Reason.Unavailable.message)
        }
    }
    AgentHomeScreen(
        name = agent?.name.orEmpty(),
        reach = reach,
        accounts = rememberAccountMenu(graph),
        onSwitchAccount = { graph.open(it) },
    )
}
