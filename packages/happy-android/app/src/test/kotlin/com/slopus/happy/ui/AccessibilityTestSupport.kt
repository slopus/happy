package com.slopus.happy.ui

import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.isRoot
import androidx.compose.ui.test.junit4.ComposeContentTestRule
import org.junit.Assert.assertTrue

/** A node TalkBack would read with [role], as happy-app's `accessibilityRole`. */
fun hasRole(role: Role): SemanticsMatcher = SemanticsMatcher.expectValue(SemanticsProperties.Role, role)

/** The words TalkBack reads for a merged node: its description, else its text. */
val SemanticsNode.spoken: String
    get() {
        val config = config
        val description = config.getOrNull(SemanticsProperties.ContentDescription).orEmpty()
        val text = config.getOrNull(SemanticsProperties.Text).orEmpty().map { it.text }
        val editable = listOfNotNull(config.getOrNull(SemanticsProperties.EditableText)?.text)
        return (description + text + editable).filter { it.isNotBlank() }.joinToString(" ")
    }

/**
 * Every node TalkBack can act on (click, long-press, toggle), described by
 * its tag, role and bounds, when it has nothing to read. In every window
 * (dialogs and popups are roots of their own). Nodes hidden from
 * accessibility don't count.
 */
fun ComposeContentTestRule.unlabelledActions(): List<String> {
    val found = mutableListOf<String>()
    fun visit(node: SemanticsNode) {
        val config = node.config
        // Hidden from accessibility hides the whole subtree.
        if (SemanticsProperties.HideFromAccessibility in config) return
        val acts = SemanticsActions.OnClick in config || SemanticsActions.OnLongClick in config ||
            SemanticsProperties.ToggleableState in config
        // A link inside text (LinkAnnotation): TalkBack reads it as part of its text.
        val link = SemanticsProperties.Role !in config && node.parent?.config?.contains(SemanticsProperties.Text) == true
        if (acts && !link && node.spoken.isEmpty()) {
            found += "tag=${config.getOrNull(SemanticsProperties.TestTag)} role=${config.getOrNull(SemanticsProperties.Role)} at ${node.boundsInRoot}"
        }
        node.children.forEach(::visit)
    }
    onAllNodes(isRoot()).fetchSemanticsNodes().forEach(::visit)
    return found
}

/** Fails, listing them, when any actionable node has nothing for TalkBack to read. */
fun ComposeContentTestRule.assertActionsLabelled() {
    val unlabelled = unlabelledActions()
    assertTrue("unlabelled actions:\n" + unlabelled.joinToString("\n"), unlabelled.isEmpty())
}
