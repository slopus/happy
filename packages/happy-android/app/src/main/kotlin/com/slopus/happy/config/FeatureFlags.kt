package com.slopus.happy.config

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * PostHog's feature flags for this install, as analytics last heard them
 * (`Analytics.start`'s `flags`): held in memory for the launch, none until
 * asked, and none whenever analytics is off. Nothing here asks PostHog;
 * without the analytics module every flag reads as off.
 */
class FeatureFlags {
    private val state = MutableStateFlow<Set<String>>(emptySet())

    /** The flags on. */
    val on: StateFlow<Set<String>> = state.asStateFlow()

    fun set(flags: Set<String>) {
        state.value = flags
    }

    companion object {
        /** Where older builds kept each account's answer; deleted at start. */
        const val RETIRED_PREFS_NAME = "feature-flags"

        /** The Happy CLI home's migration card (ui/migration). */
        const val DIRECT_CONNECTION_MIGRATION_NOTE = "direct-connection-migration-note"
    }
}
