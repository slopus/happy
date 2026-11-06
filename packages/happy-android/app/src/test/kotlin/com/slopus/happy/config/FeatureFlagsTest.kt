package com.slopus.happy.config

import org.junit.Assert.assertEquals
import org.junit.Test

/** The flags analytics heard for this install: none until told, and held in memory only. */
class FeatureFlagsTest {
    @Test
    fun everyFlagIsOffUntilAnalyticsSaysAndOffAgainWhenItGoesOff() {
        val flags = FeatureFlags()
        assertEquals(emptySet<String>(), flags.on.value)
        flags.set(setOf(FeatureFlags.DIRECT_CONNECTION_MIGRATION_NOTE))
        assertEquals(setOf("direct-connection-migration-note"), flags.on.value)
        flags.set(emptySet())
        assertEquals(emptySet<String>(), flags.on.value)
        assertEquals(emptySet<String>(), FeatureFlags().on.value)
    }
}
