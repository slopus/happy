package com.slopus.happy.chat.tools

// codexUnifiedDiff.ts: Codex's `unified_diff` tool input, before the shared
// renderer (com.slopus.happy.diff) draws it.

/** `materializeUnifiedDiffPatch`: a bare hunk gets file headers. */
fun materializeUnifiedDiffPatch(unifiedDiff: String, fileName: String, kind: String? = "update"): String {
    if ("\n--- " in unifiedDiff || unifiedDiff.startsWith("--- ") || "\n+++ " in unifiedDiff || unifiedDiff.startsWith("+++ ") ||
        unifiedDiff.startsWith("diff --git ")
    ) {
        return unifiedDiff
    }
    val oldPath = if (kind == "add") "/dev/null" else "a/$fileName"
    val newPath = if (kind == "delete") "/dev/null" else "b/$fileName"
    return "--- $oldPath\n+++ $newPath\n$unifiedDiff"
}

/** `parseUnifiedDiff(...).fileName`: the `+++` path. */
fun unifiedDiffFileName(unifiedDiff: String): String? =
    unifiedDiff.lineSequence().lastOrNull { it.startsWith("+++ ") }?.removePrefix("+++ ")?.removePrefix("b/")
