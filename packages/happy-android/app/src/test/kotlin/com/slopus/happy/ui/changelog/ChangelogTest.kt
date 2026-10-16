package com.slopus.happy.ui.changelog

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * happy-app sources/changelog: the bundled changelog.json is happy-app's,
 * byte for byte (and so are its images); its entries come newest first
 * with latestTitle the first title; parseSummary splits `[label](url)`
 * links and `![alt](path)` images out of the text; storage.ts keeps the
 * last viewed title, and a changelog is unread while its latest title is
 * neither empty nor that title.
 */
@RunWith(AndroidJUnit4::class)
class ChangelogTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private val source = File("../../happy-app/sources/changelog")

    @Test
    fun bundledChangelogIsHappyApps() {
        val bundled = context.resources.openRawResource(com.slopus.happy.R.raw.changelog).use { it.readBytes() }
        assertArrayEquals(
            "res/raw/changelog.json differs: copy happy-app/sources/changelog/changelog.json",
            source.resolve("changelog.json").readBytes(),
            bundled,
        )
        val image = File("src/main/res/drawable-nodpi/changelog_mouse_on_the_phone.webp")
        assertArrayEquals("changelog image differs from happy-app's", source.resolve("images/mouse-on-the-phone.webp").readBytes(), image.readBytes())
        for (file in source.resolve("images").listFiles().orEmpty()) {
            assertTrue("${file.name} is not in Changelog.images", "images/${file.name}" in Changelog.images)
        }
    }

    @Test
    fun bundledChangelogParses() {
        val changelog = Changelog.bundled(context.resources)
        assertTrue(changelog.entries.size > 10)
        assertEquals(changelog.entries.first().title, changelog.latestTitle)
        assertTrue(changelog.entries.all { it.title.isNotEmpty() && (it.summary.isNotEmpty() || it.markdown.isNotEmpty()) })
    }

    @Test
    fun parseIsTolerant() {
        assertEquals(Changelog.Empty, Changelog.parse("not json"))
        val changelog = Changelog.parse("""{"entries":[{"title":"A","summary":"s","markdown":"- x","titleImage":"images/a.webp","extra":1}],"latestTitle":"A"}""")
        assertEquals(listOf(ChangelogEntry("A", "s", "- x", "images/a.webp")), changelog.entries)
    }

    @Test
    fun summarySegments() {
        assertEquals(
            listOf(
                SummarySegment.Text("Thank you "),
                SummarySegment.Link("@a", "https://github.com/a"),
                SummarySegment.Text(" and "),
                SummarySegment.Image("images/x.webp"),
                SummarySegment.Text("."),
            ),
            parseSummary("Thank you [@a](https://github.com/a) and ![x](images/x.webp)."),
        )
        assertEquals(listOf(SummarySegment.Text("plain")), parseSummary("plain"))
        assertEquals(emptyList<SummarySegment>(), parseSummary(""))
    }

    @Test
    fun readMarkerRemembersTheLastViewedTitle() {
        val prefs = context.getSharedPreferences(ChangelogReadMarker.PREFS_NAME, Context.MODE_PRIVATE).also { it.edit().clear().commit() }
        val marker = ChangelogReadMarker(prefs)
        assertEquals("", marker.lastViewedTitle.value)
        assertFalse(marker.hasUnread(""))
        assertTrue(marker.hasUnread("May 12 - Hello world"))
        marker.markViewed("May 12 - Hello world")
        assertFalse(marker.hasUnread("May 12 - Hello world"))
        assertTrue(marker.hasUnread("June 26 - QR login"))
        assertEquals("May 12 - Hello world", ChangelogReadMarker(prefs).lastViewedTitle.value)
    }
}
