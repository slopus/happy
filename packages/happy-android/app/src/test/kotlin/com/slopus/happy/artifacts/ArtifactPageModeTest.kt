package com.slopus.happy.artifacts

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** `happy-page-mode: app` read from an entry's head, as desktop's selector matches it (happy-agent's docs/DESIGN.md §1.8). */
class ArtifactPageModeTest {
    @Test fun theMetaMakesAnApp() {
        assertTrue(ArtifactPageMode.declaresApp("""<!doctype html><html><head><meta charset="utf-8"><meta name="happy-page-mode" content="app"><title>Snake</title></head><body></body></html>"""))
        // Case, quotes, order and a self-closing slash don't matter.
        assertTrue(ArtifactPageMode.declaresApp("""<META CONTENT='APP' NAME='Happy-Page-Mode' />"""))
        assertTrue(ArtifactPageMode.declaresApp("<meta name=happy-page-mode content=app>"))
        assertTrue(ArtifactPageMode.declaresApp("<head>\n  <meta\n    name=\"happy-page-mode\"\n    content=\"app\"\n  >"))
    }

    @Test fun anythingElseIsAPage() {
        assertFalse(ArtifactPageMode.declaresApp("<html><head><title>Report</title></head><body>happy-page-mode app</body></html>"))
        assertFalse(ArtifactPageMode.declaresApp("""<meta name="happy-page-mode" content="page">"""))
        assertFalse(ArtifactPageMode.declaresApp("""<meta name="happy-page-mode" content="application">"""))
        assertFalse(ArtifactPageMode.declaresApp("""<meta name="happy-page-width" content="full">"""))
        assertFalse(ArtifactPageMode.declaresApp("""<meta name="happy-page-mode">"""))
        assertFalse(ArtifactPageMode.declaresApp("""<meta property="happy-page-mode" content="app">"""))
    }

    /** The addendum's `happy-app-close`: a corner, `none`, or top-start for anything else. */
    @Test fun theCloseButtonsCorner() {
        val app = """<meta name="happy-page-mode" content="app">"""
        assertEquals(AppClose.TopStart, ArtifactPageMode.read(app))
        assertEquals(AppClose.TopEnd, ArtifactPageMode.read("""$app<meta name="happy-app-close" content="top-end">"""))
        assertEquals(AppClose.BottomStart, ArtifactPageMode.read("""<meta name='happy-app-close' content='Bottom-Start'>$app"""))
        assertEquals(AppClose.BottomEnd, ArtifactPageMode.read("""$app<meta name="happy-app-close" content="bottom-end">"""))
        assertEquals(AppClose.None, ArtifactPageMode.read("""$app<meta name="happy-app-close" content="none">"""))
        assertEquals(AppClose.TopStart, ArtifactPageMode.read("""$app<meta name="happy-app-close" content="middle">"""))
        assertEquals(AppClose.TopStart, ArtifactPageMode.read("""$app<!-- <meta name="happy-app-close" content="none"> -->"""))
        // The first of each counts.
        assertEquals(AppClose.TopEnd, ArtifactPageMode.read("""$app<meta name="happy-app-close" content="top-end"><meta name="happy-app-close" content="none">"""))
        // Without app mode, a corner means nothing.
        assertNull(ArtifactPageMode.read("""<meta name="happy-app-close" content="none">"""))
    }

    @Test fun commentsAndScriptsDontDeclareAnything() {
        assertFalse(ArtifactPageMode.declaresApp("""<!-- <meta name="happy-page-mode" content="app"> --><title>x</title>"""))
        assertFalse(ArtifactPageMode.declaresApp("""<script>document.write('<meta name="happy-page-mode" content="app">')</script>"""))
        assertFalse(ArtifactPageMode.declaresApp("""<title><meta name="happy-page-mode" content="app"></title>"""))
        assertTrue(ArtifactPageMode.declaresApp("""<script>var a = 1 < 2;</script><meta name="happy-page-mode" content="app">"""))
        // Cut off mid-comment, the rest is the comment's.
        assertFalse(ArtifactPageMode.declaresApp("""<!-- unfinished <meta name="happy-page-mode" content="app">"""))
    }
}
