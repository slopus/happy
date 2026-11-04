package com.slopus.happy.todos

import com.slopus.happy.agent.AgentClient
import com.slopus.happy.agent.AgentEvent
import com.slopus.happy.agent.AgentSession
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.withContext

/**
 * The [TodoLibrary] of one agent connection: its routes over the
 * connection's client, its outbox and lists kept beside the catalog
 * ([AgentSession.keepResource], read and written off the main thread), the
 * journal's `todo.*` events and reconnects, and delivery while the link is up.
 */
internal fun connectionTodos(session: AgentSession, client: AgentClient, scope: CoroutineScope): TodoLibrary {
    val library = TodoLibrary(
        routes = AgentTodoRoutes(client),
        outbox = session.intents,
        kept = { key -> withContext(Dispatchers.IO) { session.cachedResource(key) } },
        keep = { key, value -> withContext(Dispatchers.IO) { session.keepResource(key, value) } },
        scope = scope,
    )
    library.follow(
        session.events
            .filter { it.type == AgentEvent.HELLO || it.type.startsWith("todo.") }
            .map { if (it.type == AgentEvent.HELLO) TodoFeedEvent.Resync else TodoFeedEvent.Event(it.type, it.data) },
    )
    return library
}
