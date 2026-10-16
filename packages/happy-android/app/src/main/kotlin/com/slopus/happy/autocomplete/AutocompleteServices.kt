package com.slopus.happy.autocomplete

import com.slopus.happy.AppGraph
import com.slopus.happy.sync.RipgrepResult
import java.util.WeakHashMap

/**
 * The graph's file listings for `@` mentions: one cache for the app, as in
 * happy-app, keyed by session (ids don't repeat across accounts). Listings
 * go through the signed-in account's session ripgrep RPC.
 */
class AutocompleteServices private constructor(graph: AppGraph) {
    val files = FileSearchCache(ripgrep = { sessionId, args ->
        graph.account.value?.sessionOps?.ripgrep(sessionId, args) ?: RipgrepResult(false, error = "Not signed in")
    })

    companion object {
        private val instances = WeakHashMap<AppGraph, AutocompleteServices>()

        fun of(graph: AppGraph): AutocompleteServices = synchronized(instances) {
            instances.getOrPut(graph) { AutocompleteServices(graph) }
        }
    }
}
