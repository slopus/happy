package com.slopus.happy.diff

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.ceil

/** happy-app components/diff/layout.spec.ts, engine/splitRows.spec.ts and engine/lru.spec.ts. */
class DiffLayoutTest {
    private fun line(key: String, type: DiffLineType, text: String = key, oldNo: Int? = null, newNo: Int? = null) =
        DiffRow.Line(key, type, oldNo, newNo, text, listOf(DiffSpan(text, SpanKind.Plain, SpanEmphasis.None)))

    private fun hunk(key: String) = DiffRow.Hunk(key, "@@ -1 +1 @@", "", null)

    private fun ctxRun(count: Int, prefix: String = "c") = (0 until count).map { line("$prefix$it", DiffLineType.Ctx) }

    private fun visible(rows: List<DiffRow>, collapseAfter: Int, headers: Boolean = true, expanded: Boolean = false) =
        DiffLayout.selectVisibleRows(rows, headers, expanded, collapseAfter)

    @Test
    fun selectVisibleRows() {
        // Everything under the limit.
        val short = ctxRun(10)
        visible(short, 80).let {
            assertEquals(short, it.rows)
            assertEquals(0, it.hiddenCount)
        }
        // Hunk separators dropped when off.
        visible(listOf(hunk("h0")) + ctxRun(3), 80, headers = false).let {
            assertEquals(3, it.rows.size)
            assertTrue(it.rows.all { row -> row is DiffRow.Line })
        }
        // Collapses to the limit and reports the rest; expanded shows all.
        visible(ctxRun(100), 80).let {
            assertEquals(80, it.rows.size)
            assertEquals(20, it.hiddenCount)
        }
        visible(ctxRun(100), 80, expanded = true).let {
            assertEquals(100, it.rows.size)
            assertEquals(0, it.hiddenCount)
        }
        // Never between removals and their additions.
        val block = ctxRun(8) + listOf(line("d0", DiffLineType.Del), line("d1", DiffLineType.Del), line("a0", DiffLineType.Add), line("a1", DiffLineType.Add)) + ctxRun(20, "tail")
        visible(block, 10).let {
            assertTrue(it.rows.map { row -> row.key }.containsAll(listOf("a0", "a1")))
            assertEquals(12, it.rows.size)
            assertEquals(20, it.hiddenCount)
        }
        // Still cuts on a context line.
        visible(ctxRun(20) + listOf(line("d0", DiffLineType.Del), line("a0", DiffLineType.Add)), 10).let {
            assertEquals(10, it.rows.size)
            assertEquals(12, it.hiddenCount)
        }
        // Bounded chase.
        val changes = (0 until 500).map { line("d$it", if (it % 2 == 0) DiffLineType.Del else DiffLineType.Add) } + ctxRun(10, "tail")
        visible(changes, 100).let {
            assertTrue(it.rows.size <= 300)
            assertTrue(it.hiddenCount > 0)
        }
        // Counts add up wherever the cut lands.
        val mixed = ctxRun(5) + listOf(line("d0", DiffLineType.Del), line("a0", DiffLineType.Add)) + ctxRun(5, "mid") +
            listOf(line("d1", DiffLineType.Del), line("a1", DiffLineType.Add)) + ctxRun(5, "tail")
        for (limit in 1..mixed.size) {
            val result = visible(mixed, limit)
            assertEquals(mixed.size, result.rows.size + result.hiddenCount)
        }
    }

    @Test
    fun gutterWidth() {
        assertEquals(ceil(2 * 7f) + 4, DiffLayout.gutterWidth(7f, 1234, false))
        assertTrue(DiffLayout.gutterWidth(7f, 12345, true) > DiffLayout.gutterWidth(7f, 9, true))
        assertEquals(DiffLayout.gutterWidth(7f, 99, true), DiffLayout.gutterWidth(7f, 1, true))
        assertTrue(DiffLayout.gutterWidth(10f, 100, true) > DiffLayout.gutterWidth(5f, 100, true))
    }

    @Test
    fun splitRows() {
        val ctx = line("a", DiffLineType.Ctx, "same", 1, 1)
        assertEquals(listOf(SplitRow.Pair("a", ctx, ctx)), buildSplitRows(listOf(ctx)))

        val del = line("d", DiffLineType.Del, "old", 4)
        val add = line("a", DiffLineType.Add, "new", newNo = 4)
        buildSplitRows(listOf(del, add)).single().let {
            it as SplitRow.Pair
            assertSame(del, it.left)
            assertSame(add, it.right)
        }

        val uneven = buildSplitRows(
            listOf(line("d0", DiffLineType.Del, "a", 1), line("d1", DiffLineType.Del, "b", 2), line("d2", DiffLineType.Del, "c", 3), line("a0", DiffLineType.Add, "A", newNo = 1)),
        ).map { it as SplitRow.Pair }
        assertEquals(listOf("d0", "d1", "d2"), uneven.map { it.left?.key })
        assertEquals(listOf("a0", null, null), uneven.map { it.right?.key })

        buildSplitRows(listOf(line("a0", DiffLineType.Add, "added", newNo = 7))).single().let {
            it as SplitRow.Pair
            assertNull(it.left)
            assertEquals("a0", it.right?.key)
        }

        val full = buildSplitRows(listOf(DiffRow.Hunk("h0", "@@ -1,2 +1,2 @@", "", null), DiffRow.Message("m0", DiffRow.Message.Code.Binary)))
        assertTrue(full.all { it is SplitRow.Full })

        DiffBuilder.clearCache()
        val doc = DiffBuilder.fromPatch(
            listOf("--- a/x.ts", "+++ b/x.ts", "@@ -1,4 +1,4 @@", " const a = 1;", "-const b = 2;", "-const c = 3;", "+const b = 20;", " const d = 4;", "@@ -10,2 +10,3 @@", " const e = 5;", "+const f = 6;", "").joinToString("\n"),
        )
        val keys = buildSplitRows(doc.files[0].rows).map { it.key }
        assertEquals(keys.size, keys.toSet().size)

        val small = DiffBuilder.fromPatch(listOf("--- a/x.ts", "+++ b/x.ts", "@@ -1,3 +1,3 @@", " keep", "-drop", "+gain", "").joinToString("\n")).files[0].rows
        val seen = buildSplitRows(small).filterIsInstance<SplitRow.Pair>().flatMap { listOfNotNull(it.left?.key, it.right?.key) }.toSet()
        assertEquals(small.count { it is DiffRow.Line }, seen.size)
    }

    @Test
    fun lruEvictsTheLeastRecentlyRead() {
        val cache = DiffLruCache<Int>(2)
        cache.set("a", 1)
        cache.set("b", 2)
        assertEquals(1, cache.get("a"))
        cache.set("c", 3)
        assertNull(cache.get("b"))
        cache.set("a", 4)
        assertEquals(3, cache.get("c"))
        assertEquals(4, cache.get("a"))
        cache.clear()
        assertNull(cache.get("a"))
    }

    @Test
    fun lruBoundsWeight() {
        val cache = DiffLruCache<Int>(48, 10)
        cache.set("a", 1, 5)
        cache.set("b", 2, 5)
        cache.set("b", 3, 6)
        assertNull(cache.get("a"))
        assertEquals(3, cache.get("b"))
        cache.set("b", 4, 11)
        assertNull(cache.get("b"))
        cache.set("c", 5, 10)
        assertEquals(5, cache.get("c"))
    }
}
