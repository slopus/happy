package com.slopus.happy.vaults

/**
 * The retention presets a vault's settings offer (vaults-design.md,
 * "Retention"), and which one a policy is. A preset sets how versions are
 * kept; how long the Trash holds things is its own setting and stays as
 * it was. Anything else is Custom.
 */
enum class VaultRetentionPreset {
    /** Every version for a day, one a day until 30 days, one a week after: a new vault's policy. */
    TimeMachine,
    KeepEverything,
    LastTen,
    Custom;

    /** The policy this preset makes of [current], keeping its Trash; Custom keeps it all. */
    fun applied(current: VaultRetention): VaultRetention = when (this) {
        KeepEverything -> VaultRetention(null, null, 0, emptyList(), current.trashDays)
        LastTen -> VaultRetention(10, null, 0, emptyList(), current.trashDays)
        TimeMachine -> VaultRetention(null, null, 1, listOf(VaultRetentionTier(1, 1), VaultRetentionTier(30, 7)), current.trashDays)
        Custom -> current
    }

    companion object {
        val offered = listOf(TimeMachine, KeepEverything, LastTen, Custom)

        /** The preset [retention] is, whatever its Trash; Custom when none. */
        fun of(retention: VaultRetention): VaultRetentionPreset =
            offered.firstOrNull { it != Custom && it.applied(retention) == retention } ?: Custom

        /** The Trash durations offered, in days; null keeps things until they are restored. */
        val trashChoices: List<Int?> = listOf(7, 30, 90, 365, null)

        /**
         * Why [retention] can't be saved, as the daemon would refuse it, or
         * null when it can: tiers in strictly increasing `afterDays`, at most
         * eight, and every number in its range.
         */
        fun problem(retention: VaultRetention): Problem? {
            if (retention.maxVersions != null && retention.maxVersions !in 1..10_000) return Problem.MaxVersions
            if (retention.maxAgeDays != null && retention.maxAgeDays !in 1..36_500) return Problem.MaxAge
            if (retention.keepAllDays !in 0..36_500) return Problem.KeepAll
            if (retention.thinning.size > 8) return Problem.TooManyTiers
            if (retention.thinning.any { it.afterDays !in 0..36_500 || it.everyDays !in 1..3_650 }) return Problem.Tier
            if (retention.thinning.zipWithNext().any { (a, b) -> b.afterDays <= a.afterDays }) return Problem.TierOrder
            if (retention.trashDays != null && retention.trashDays !in 1..3_650) return Problem.Trash
            return null
        }
    }

    enum class Problem { MaxVersions, MaxAge, KeepAll, TooManyTiers, Tier, TierOrder, Trash }
}
