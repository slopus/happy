package com.slopus.happy.model.settings

/** happy-app utils/versionUtils.ts. */
object Versions {
    /**
     * compareVersions: the numeric core only, prerelease stripped
     * ("0.10.0-1" equals "0.10.0"), shorter versions padded with zeros.
     */
    fun compare(version1: String, version2: String): Int {
        fun parts(v: String) = v.split('-')[0].split('.').map { it.toDoubleOrNull() ?: Double.NaN }
        val a = parts(version1)
        val b = parts(version2)
        for (i in 0 until maxOf(a.size, b.size)) {
            val x = a.getOrElse(i) { 0.0 }
            val y = b.getOrElse(i) { 0.0 }
            // NaN compares neither way, as in JavaScript.
            if (x > y) return 1
            if (x < y) return -1
        }
        return 0
    }

    /**
     * compareVersionsWithPrerelease: semver order. A release ranks above any
     * prerelease of its core, numeric prerelease segments compare as
     * numbers, build metadata is ignored.
     */
    fun compareWithPrerelease(rawVersion1: String, rawVersion2: String): Int {
        val version1 = rawVersion1.split('+')[0]
        val version2 = rawVersion2.split('+')[0]
        val core = compare(version1, version2)
        if (core != 0) return core

        val pre1 = version1.split('-').drop(1).joinToString("-")
        val pre2 = version2.split('-').drop(1).joinToString("-")
        if (pre1.isEmpty() && pre2.isEmpty()) return 0
        if (pre1.isEmpty()) return 1
        if (pre2.isEmpty()) return -1

        val segments1 = pre1.split('.')
        val segments2 = pre2.split('.')
        val digits = Regex("^\\d+$")
        for (i in 0 until maxOf(segments1.size, segments2.size)) {
            val a = segments1.getOrNull(i) ?: return -1
            val b = segments2.getOrNull(i) ?: return 1
            val aNumeric = digits.matches(a)
            val bNumeric = digits.matches(b)
            if (aNumeric && bNumeric) {
                val aTrimmed = a.replace(Regex("^0+(?=\\d)"), "")
                val bTrimmed = b.replace(Regex("^0+(?=\\d)"), "")
                if (aTrimmed.length != bTrimmed.length) return if (aTrimmed.length < bTrimmed.length) -1 else 1
                if (aTrimmed != bTrimmed) return if (aTrimmed < bTrimmed) -1 else 1
            } else if (aNumeric != bNumeric) {
                return if (aNumeric) -1 else 1
            } else if (a != b) {
                return if (a < b) -1 else 1
            }
        }
        return 0
    }

    /** isWellFormedVersion: numeric core, optional prerelease and build metadata. */
    fun isWellFormed(version: String): Boolean =
        Regex("^\\d+\\.\\d+\\.\\d+(-[0-9A-Za-z.-]+)?(\\+[0-9A-Za-z.-]+)?$").matches(version)
}
