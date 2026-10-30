package com.slopus.happy.ui.conversation

import android.content.Context
import android.view.View
import android.view.accessibility.AccessibilityManager
import android.view.accessibility.AccessibilityNodeInfo
import androidx.compose.ui.InternalComposeUiApi
import androidx.compose.ui.autofill.ContentDataType
import androidx.compose.ui.platform.ViewRootForTest
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.hasAnyChild
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performTextInput
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.slopus.happy.conversation.Question
import com.slopus.happy.ui.PHONE
import com.slopus.happy.ui.setHappyContent
import com.slopus.happy.ui.spoken
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * Where a typed secret may and may not appear. Compose keeps two texts for an
 * editable field: `EditableText`, the transformed one (here, dots), and
 * `InputText`, the raw one the IME and the test framework edit. Only the first
 * is read by `AndroidComposeViewAccessibilityDelegateCompat`, so the test that
 * matters is the one below: the `AccessibilityNodeInfo` a screen reader is
 * actually handed.
 *
 * Every value here is invented for the test.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = PHONE)
class SecretMaskingTest {
    @get:Rule
    val rule = createComposeRule()

    private val secret = "token-synthetic-9f2c"

    private val request = Question.SecretRequest(
        suggestedId = "deploy-api",
        description = "Staging deployment API credentials",
        variables = listOf(Question.SecretVariable("DEPLOY_API_TOKEN", "Token with the deploy scope")),
    )

    private val question = Question(
        id = "q1",
        status = "pending",
        context = "The deploy step needs the staging API token.",
        prompts = listOf(Question.Prompt("secret", "Secret", "Staging token", false, emptyList(), request)),
        permissionFrom = null,
        isPermission = false,
    )

    private val actions = SecretRequestActions(secrets = { emptyList() }, create = { _, _, _ -> "made" })

    /** Accessibility switched on, the way it is while a screen reader runs. */
    @Before fun turnAccessibilityOn() {
        val manager = ApplicationProvider.getApplicationContext<Context>()
            .getSystemService(Context.ACCESSIBILITY_SERVICE) as AccessibilityManager
        shadowOf(manager).setEnabled(true)
        shadowOf(manager).setTouchExplorationEnabled(true)
    }

    private fun field() = rule.onAllNodesWithTag(SecretRequestTags.VALUE, useUnmergedTree = true).onFirst()

    @OptIn(InternalComposeUiApi::class)
    private fun composeView(): View = (rule.onRoot().fetchSemanticsNode().root as ViewRootForTest).view

    /**
     * Who is asking, as the delegate decides it. The platform only says yes
     * while it is serving a service that declares `isAccessibilityTool`, and
     * Robolectric can't put the framework in that state, so this is Compose's
     * own hook for exactly this question. Reflection only because the name is
     * mangled — missing hook fails the test rather than passing it quietly, and
     * what it proves is what the delegate does with the answer, not that the
     * platform enforces it.
     */
    private fun askAsAccessibilityTool(tool: Boolean) {
        val view = composeView()
        val delegate = Class.forName("androidx.compose.ui.platform.AndroidComposeView")
            .getDeclaredMethod("access\$getComposeAccessibilityDelegate\$p", view.javaClass)
            .invoke(null, view)
        checkNotNull(delegate) { "no accessibility delegate on the compose view" }
        delegate.javaClass
            .getMethod("setRequestFromAccessibilityToolForTesting\$ui", java.lang.Boolean::class.java)
            .invoke(delegate, tool)
    }

    private fun accessibilityInfo(): AccessibilityNodeInfo {
        val provider = requireNonNull(composeView().accessibilityNodeProvider, "no accessibility node provider")
        return requireNonNull(
            provider.createAccessibilityNodeInfo(field().fetchSemanticsNode().id),
            "no node for the value field",
        )
    }

    private fun <T : Any> requireNonNull(value: T?, message: String): T {
        assertNotNull(message, value)
        return value!!
    }

    @Test fun `a screen reader is handed dots and a password flag, never the value`() {
        rule.setHappyContent { SecretRequestForm(request, actions) {} }
        field().performTextInput(secret)
        askAsAccessibilityTool(true)
        val info = accessibilityInfo()
        val read = listOfNotNull(info.text, info.contentDescription, info.hintText, info.tooltipText, info.stateDescription)
            .joinToString(" | ") { it.toString() }
        assertFalse(read, read.contains(secret))
        assertEquals("•".repeat(secret.length), info.text?.toString())
        // Android's own contract for a credential field: an EditText that says
        // it holds a password, so no character echo and no reading it out.
        assertTrue("isPassword", info.isPassword)
        assertEquals("android.widget.EditText", info.className)
        // And it says it holds sensitive data, for a platform that acts on it.
        assertTrue("isAccessibilityDataSensitive", info.isAccessibilityDataSensitive)
    }

    @Test fun `a service that is not an accessibility tool is handed no field at all`() {
        rule.setHappyContent { SecretRequestForm(request, actions) {} }
        field().performTextInput(secret)
        askAsAccessibilityTool(false)
        val provider = requireNonNull(composeView().accessibilityNodeProvider, "no accessibility node provider")
        // Nothing for the value field...
        assertNull(provider.createAccessibilityNodeInfo(field().fetchSemanticsNode().id))
        // ...while the rest of the form is there as usual, so this is the one
        // node being withheld rather than accessibility having gone missing.
        val label = rule.onNodeWithText("DEPLOY_API_TOKEN", useUnmergedTree = true).fetchSemanticsNode()
        assertEquals(
            "DEPLOY_API_TOKEN",
            provider.createAccessibilityNodeInfo(label.id)?.text?.toString(),
        )
    }

    @Test fun `the field is labelled the way Compose labels a field`() {
        rule.setHappyContent { SecretRequestForm(request, actions) {} }
        // Compose's delegate drops a content description for an editable node —
        // Material's own TextField(label = …) lands the same way — so the label
        // is a node directly before the field, inside one traversal group: the
        // field's own, not the scrolling fields around it, which is one too.
        val group = rule.onNode(
            SemanticsMatcher.expectValue(SemanticsProperties.IsTraversalGroup, true) and
                hasAnyChild(hasTestTag(SecretRequestTags.VALUE)),
            useUnmergedTree = true,
        ).fetchSemanticsNode()
        val said = StringBuilder()
        fun visit(node: SemanticsNode) {
            said.append(node.spoken).append(' ')
            node.children.forEach(::visit)
        }
        visit(group)
        assertTrue(said.toString(), said.contains("DEPLOY_API_TOKEN"))
        assertTrue(said.toString(), said.contains("Token with the deploy scope"))
    }

    @Test fun `the whole accessibility tree never carries the value`() {
        rule.setHappyContent { SecretRequestForm(request, actions) {} }
        field().performTextInput(secret)
        // Every node of the tree, as a service walking it would be read them.
        val said = StringBuilder()
        fun visit(node: SemanticsNode) {
            said.append(node.spoken).append('\n')
            node.children.forEach(::visit)
        }
        visit(rule.onRoot(useUnmergedTree = true).fetchSemanticsNode())
        assertFalse(said.toString(), said.contains(secret))
    }

    @Test fun `no password manager is offered the value`() {
        rule.setHappyContent { SecretRequestForm(request, actions) {} }
        field().performTextInput(secret)
        // ContentDataType.None keeps the field out of the autofill view
        // structure, so an agent's credential is never offered for saving to
        // the user's own autofill service.
        assertEquals(
            ContentDataType.None,
            field().fetchSemanticsNode().config.getOrNull(SemanticsProperties.ContentDataType),
        )
    }

    @Test fun `a value typed in is gone after the screen is rebuilt from saved state`() {
        val restoration = StateRestorationTester(rule)
        restoration.setContent { SecretRequestForm(request, actions) {} }
        field().performTextInput(secret)
        restoration.emulateSavedInstanceStateRestore()
        // The form is here again, and empty: the value was never in saved state
        // to come back from, and nothing repopulates it.
        val after = field().fetchSemanticsNode().config
        assertEquals("", after.getOrNull(SemanticsProperties.EditableText)?.text ?: "")
        assertEquals("", after.getOrNull(SemanticsProperties.InputText)?.text ?: "")
    }
}
