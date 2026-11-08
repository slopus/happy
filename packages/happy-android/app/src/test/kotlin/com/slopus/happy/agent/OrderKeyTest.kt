package com.slopus.happy.agent

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** happy-agent's order keys, with its own cases (`packages/happy-agent-modules/tests/surfaces/sharedOrdering.test.ts`; iOS `OrderKeyTests`). */
class OrderKeyTest {
    private val canonical = Regex("^[0-9]*[1-9]$")

    @Test
    fun keysBetweenAreHappyAgents() {
        val cases = listOf(
            Triple(null, null, "5"),
            Triple("5", null, "6"),
            Triple("8", null, "9"),
            Triple("9", null, "91"),
            Triple("99", null, "9901"),
            Triple("9909", null, "991"),
            Triple("991", null, "9911"),
            Triple("00000000000000000001", null, "1"),
            Triple("0000000000000000000000000000000000000000000000000000000000000001", null, "1"),
            Triple("5", "7", "6"),
            Triple("5", "6", "55"),
            Triple("55", "6", "57"),
            Triple("4", "5", "45"),
            Triple(null, "5", "4"),
            Triple(null, "1", "09"),
            Triple(null, "01", "0099"),
            Triple(null, "0091", "009"),
            Triple(null, "009", "0089"),
            Triple(null, "00000000000000000001", "00000000000000000000999999999999"),
            Triple("00000000000000000010", "00000000000000000011", "000000000000000000105"),
        )
        for ((before, after, expected) in cases) assertEquals("$before $after", expected, OrderKey.between(before, after))
    }

    @Test
    fun insertsAmongMixedKeysNeverRewriteANeighbour() {
        val keys = mutableListOf("00000000000000000001", "00000000000000000002", "5", "7")
        val originals = keys.toList()
        for (step in 0 until 500) {
            val index = (step * 31) % (keys.size + 1)
            val before = keys.getOrNull(index - 1)
            val after = keys.getOrNull(index)
            val key = OrderKey.between(before, after)!!
            assertTrue(key, canonical.matches(key))
            if (before != null) assertTrue(key > before)
            if (after != null) assertTrue(key < after)
            keys.add(index, key)
        }
        assertEquals(keys.sorted(), keys)
        for (key in originals) assertTrue(key, key in keys)
    }

    @Test
    fun placingFirstOrLastAgainAndAgainKeepsKeysShort() {
        for (first in listOf(true, false)) {
            val keys = ArrayList<String>()
            repeat(1000) {
                val key = if (first) OrderKey.between(null, keys.firstOrNull())!! else OrderKey.between(keys.lastOrNull(), null)!!
                assertTrue(key, canonical.matches(key))
                if (first) keys.add(0, key) else keys.add(key)
            }
            assertEquals(keys.sorted(), keys)
            assertEquals(keys.size, keys.toSet().size)
            assertTrue(keys.maxOf { it.length } <= 8)
        }
    }

    @Test
    fun justBeforeStepsBelowTheNextAndRefusesBoundsWithNothingBetween() {
        assertEquals("4", OrderKey.justBefore("1", "5"))
        assertEquals("19", OrderKey.justBefore("1", "2"))
        assertEquals("1099", OrderKey.justBefore("1", "11"))
        assertEquals("00000000000000000009999999999999", OrderKey.justBefore(null, "00000000000000000010"))
        assertNull(OrderKey.justBefore("1", "10"))
        assertNull(OrderKey.between(null, "0"))
        // Nothing sorts between a key and the same key with zeros after it.
        assertNull(OrderKey.between("1", "10"))
        assertNull(OrderKey.between("0000000000000000001", "00000000000000000010"))
        assertNull(OrderKey.between("6", "5"))
        assertEquals("1", OrderKey.between("00000000000000000010", null))
    }
}
