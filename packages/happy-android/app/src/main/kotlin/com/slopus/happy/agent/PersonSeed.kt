package com.slopus.happy.agent

/** iOS ddcdcdf55: the same team member has the same placeholder on every computer. */
object PersonSeed {
    fun seed(userId: String?, otherwise: String): String = userId?.takeIf { it.isNotEmpty() } ?: otherwise
}