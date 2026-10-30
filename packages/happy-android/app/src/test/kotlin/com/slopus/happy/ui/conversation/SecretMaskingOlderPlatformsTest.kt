package com.slopus.happy.ui.conversation

import android.content.Context
import android.os.Build
import android.view.View
import android.view.accessibility.AccessibilityManager
import android.view.accessibility.AccessibilityNodeInfo
import androidx.compose.ui.InternalComposeUiApi
import androidx.compose.ui.platform.ViewRootForTest
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performTextInput
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.conversation.Question
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.setHappyContent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * The secret field on Android 8.0 (API 26, this app's minimum) and Android 13
 * (API 33, the last before `isAccessibilityDataSensitive`). Below API 34 the
 * platform has no way to ask whether a service is an accessibility tool, so
 * Compose answers yes for everyone and `isSensitiveData` withholds nothing:
 * every enabled accessibility service is handed the field's node. What keeps
 * the value out of reach there is the masking alone, and that is what this
 * pins: the node is there, and it is dots and a password flag, never the value.
 *
 * Nothing here is faked about who is asking; [SecretMaskingTest] covers the
 * API 34+ withholding with Compose's test hook. Every value is invented.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE, sdk = [26, 33])
class SecretMaskingOlderPlatformsTest {
    @get:Rule
    val rule = createComposeRule()

    private val secret = "token-synthetic-9f2c"

    private val request = Question.SecretRequest(
        suggestedId = "deploy-api",
        description = "Staging deployment API credentials",
        variables = listOf(Question.SecretVariable("DEPLOY_API_TOKEN", "Token with the deploy scope")),
    )

    private val actions = SecretRequestActions(secrets = { emptyList() }, create = { _, _, _ -> "made" })

    /** Accessibility switched on, the way it is while any service runs. */
    @Before fun turnAccessibilityOn() {
        val manager = ApplicationProvider.getApplicationContext<Context>()
            .getSystemService(Context.ACCESSIBILITY_SERVICE) as AccessibilityManager
        shadowOf(manager).setEnabled(true)
        shadowOf(manager).setTouchExplorationEnabled(true)
    }

    private fun field() = rule.onAllNodesWithTag(SecretRequestTags.VALUE, useUnmergedTree = true).onFirst()

    @OptIn(InternalComposeUiApi::class)
    private fun composeView(): View = (rule.onRoot().fetchSemanticsNode().root as ViewRootForTest).view

    /** Everything a service can read off a node, as far as this platform has it (tooltip and pane title are API 28). */
    private fun said(info: AccessibilityNodeInfo): String {
        val newer = if (Build.VERSION.SDK_INT >= 28) listOf(info.tooltipText, info.paneTitle) else emptyList()
        return (listOf(info.text, info.contentDescription, info.hintText) + newer)
            .filterNotNull()
            .joinToString(" | ") { it.toString() }
    }

    @Test fun `every service is handed the field, masked and flagged as a password`() {
        assertTrue("running on API ${Build.VERSION.SDK_INT}", Build.VERSION.SDK_INT in 26..33)
        rule.setHappyContent { SecretRequestForm(request, actions) {} }
        field().performTextInput(secret)
        val provider = composeView().accessibilityNodeProvider
        assertNotNull("no accessibility node provider", provider)
        // No asking as a tool: below API 34 there is no such question, and the node comes anyway.
        val info = provider!!.createAccessibilityNodeInfo(field().fetchSemanticsNode().id)
        assertNotNull("API ${Build.VERSION.SDK_INT}: the value field's node is handed out", info)
        assertEquals("•".repeat(secret.length), info!!.text?.toString())
        assertTrue("isPassword", info.isPassword)
        assertEquals("android.widget.EditText", info.className)
        assertFalse(said(info), said(info).contains(secret))
    }

    @Test fun `no node a service can ask for carries the value`() {
        rule.setHappyContent { SecretRequestForm(request, actions) {} }
        field().performTextInput(secret)
        val provider = composeView().accessibilityNodeProvider!!
        // Every node of the tree, as a service walking it would be handed them.
        val ids = ArrayList<Int>()
        fun visit(node: SemanticsNode) {
            ids += node.id
            node.children.forEach(::visit)
        }
        visit(rule.onRoot(useUnmergedTree = true).fetchSemanticsNode())
        val handed = ids.mapNotNull { provider.createAccessibilityNodeInfo(it) }
        assertTrue("API ${Build.VERSION.SDK_INT}: only ${handed.size} of ${ids.size} nodes", handed.size > 1)
        val everything = handed.joinToString("\n", transform = ::said)
        assertFalse(everything, everything.contains(secret))
        // The field is among them, so this walk saw it rather than missing it.
        assertTrue(everything, everything.contains("•".repeat(secret.length)))
    }
}
