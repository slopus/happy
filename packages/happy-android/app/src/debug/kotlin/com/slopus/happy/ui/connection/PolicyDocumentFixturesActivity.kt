package com.slopus.happy.ui.connection

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import com.slopus.happy.agent.AgentEvent
import com.slopus.happy.agent.PolicyDocument
import com.slopus.happy.agent.PolicyDocumentSource
import com.slopus.happy.ui.theme.HappyTheme
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow

/**
 * Debug builds only: a policy document's page over an in-memory server.
 * `--es policy.document security` for the security policy, `--ez policy.member true`
 * for a member who reads it. Start it with
 * `adb shell am start -n com.slopus.happy.dev/com.slopus.happy.ui.connection.PolicyDocumentFixturesActivity`.
 */
class PolicyDocumentFixturesActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        val document = PolicyDocument.of(intent.getStringExtra("policy.document")) ?: PolicyDocument.Instructions
        val member = intent.getBooleanExtra("policy.member", false)
        var kept = if (document == PolicyDocument.Instructions) INSTRUCTIONS else ""
        setContent {
            HappyTheme {
                val scope = rememberCoroutineScope()
                val source = remember {
                    PolicyDocumentSource({ delay(400); kept }, { delay(600); kept = it; it }, MutableSharedFlow<AgentEvent>(), scope)
                }
                PolicyDocumentScreen(document, source, editable = !member, onBack = ::finish)
            }
        }
    }

    private companion object {
        const val INSTRUCTIONS = "# Acme\n\nAnswer in English unless asked otherwise.\n\n## Repositories\n\n- Work on a branch; open a pull request for every change.\n- Run the tests before asking for review.\n\n## Tone\n\nShort, plain sentences. No emoji.\n"
    }
}
