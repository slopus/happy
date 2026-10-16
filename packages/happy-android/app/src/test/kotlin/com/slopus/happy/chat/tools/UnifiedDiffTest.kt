package com.slopus.happy.chat.tools

import com.slopus.happy.diff.DiffSource
import com.slopus.happy.diff.FileChangeKind
import org.junit.Assert.assertEquals
import org.junit.Test

class UnifiedDiffTest {
    @Test
    fun aBareHunkGetsHeaders() {
        val patch = materializeUnifiedDiffPatch("@@ -0,0 +1 @@\n+x", "b.ts", "add")
        assertEquals("--- /dev/null\n+++ b/b.ts\n@@ -0,0 +1 @@\n+x", patch)
        assertEquals("b.ts", unifiedDiffFileName(patch))
        // The shared renderer reads it as a new file.
        val file = DiffSource.Patch(patch).build().files.single()
        assertEquals(FileChangeKind.Added, file.kind)
        assertEquals("b.ts", file.path)
        val deleted = materializeUnifiedDiffPatch("@@ -1 +0,0 @@\n-x", "c.ts", "delete")
        assertEquals("--- a/c.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-x", deleted)
    }

    @Test
    fun aPatchWithHeadersIsLeftAlone() {
        val patch = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b"
        assertEquals(patch, materializeUnifiedDiffPatch(patch, "y"))
        assertEquals("x", unifiedDiffFileName(patch))
    }
}
