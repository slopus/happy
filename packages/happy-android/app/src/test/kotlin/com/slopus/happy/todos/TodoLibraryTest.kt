package com.slopus.happy.todos

import com.slopus.happy.agent.AgentApiException
import com.slopus.happy.agent.Intent
import com.slopus.happy.agent.IntentOutbox
import com.slopus.happy.agent.IntentStorage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test
import java.io.IOException

/**
 * A computer's todo routes as API.md has them (iOS's FakeTodoServer):
 * versions on every change, `If-Match` checked, a repeated creation ID
 * answered with the first todo, new todos first. It can be taken away, and
 * every write is heard.
 */
private class FakeTodoServer(val surfaceId: String) : TodoRoutes {
    data class Write(val method: String, val todoId: String, val mutationId: String, val body: String)

    val todos = HashMap<String, TodoItem>()
    val writes = ArrayList<Write>()
    @Volatile var away = false
    @Volatile var refuseText: String? = null
    private var counter = 0

    private fun version() = "v%06d".format(++counter)
    private fun reachable() { if (away) throw IOException("away") }
    private fun active() = todos.values.filter { it.status == TodoItem.Status.Active }.sortedWith(TodoOrder.active)

    @Synchronized fun elsewhere(id: String, change: (TodoItem) -> TodoItem): TodoItem =
        change(todos.getValue(id)).copy(version = version()).also { todos[id] = it }

    @Synchronized fun seed(id: String, text: String, status: TodoItem.Status = TodoItem.Status.Active, author: String? = null): TodoItem {
        val key = if (status == TodoItem.Status.Active) TodoOrder.key(active().lastOrNull()?.orderKey, null) else null
        return TodoItem(id, surfaceId, text, status, key, author, 1.0, 1.0,
            if (status == TodoItem.Status.Completed) 5.0 else null, if (status == TodoItem.Status.Deleted) 6.0 else null, version()).also { todos[id] = it }
    }

    @Synchronized fun snapshot() = todos.toMap()
    @Synchronized fun writeLog() = writes.toList()
    fun order() = snapshot().values.filter { it.status == TodoItem.Status.Active }.sortedWith(TodoOrder.active).map { it.text }

    override suspend fun todos(surfaceId: String, scope: TodoItem.Status): List<TodoItem> = synchronized(this) {
        reachable()
        todos.values.filter { it.status == scope }
    }

    override suspend fun todo(surfaceId: String, todoId: String): TodoItem = synchronized(this) {
        reachable()
        todos[todoId] ?: throw AgentApiException(404, "not_found", null)
    }

    override suspend fun create(surfaceId: String, id: String, text: String, mutationId: String): TodoItem = synchronized(this) {
        reachable()
        writes += Write("POST", id, mutationId, text)
        todos[id]?.let { return@synchronized it }
        TodoItem(id, surfaceId, text, orderKey = TodoOrder.key(null, active().firstOrNull()?.orderKey), createdAt = 2.0, updatedAt = 2.0, version = version())
            .also { todos[id] = it }
    }

    private fun check(todoId: String, ifMatch: String): TodoItem {
        val todo = todos[todoId] ?: throw AgentApiException(404, "not_found", null)
        if (todo.version != ifMatch) throw AgentApiException(409, "conflict", "Stale version")
        return todo
    }

    override suspend fun update(surfaceId: String, todoId: String, text: String?, status: TodoItem.Status?, ifMatch: String, mutationId: String): TodoItem = synchronized(this) {
        reachable()
        writes += Write("PATCH", todoId, mutationId, text ?: status?.wire.orEmpty())
        if (refuseText != null && text == refuseText) throw AgentApiException(400, "invalid_request", "That text isn't allowed")
        var todo = check(todoId, ifMatch)
        if (text != null) todo = todo.copy(text = text)
        if (status != null && status != todo.status) {
            todo = when (status) {
                TodoItem.Status.Active -> todo.copy(status = status, completedAt = null, deletedAt = null, orderKey = TodoOrder.key(active().lastOrNull()?.orderKey, null))
                TodoItem.Status.Completed -> todo.copy(status = status, completedAt = 9.0, deletedAt = null, orderKey = null)
                TodoItem.Status.Deleted -> todo.copy(status = status, deletedAt = 9.0, orderKey = null)
            }
        }
        todo.copy(version = version()).also { todos[todoId] = it }
    }

    override suspend fun delete(surfaceId: String, todoId: String, ifMatch: String, mutationId: String): TodoItem = synchronized(this) {
        reachable()
        writes += Write("DELETE", todoId, mutationId, "")
        val todo = check(todoId, ifMatch)
        if (todo.status == TodoItem.Status.Deleted) return@synchronized todo
        todo.copy(status = TodoItem.Status.Deleted, deletedAt = 9.0, orderKey = null, version = version()).also { todos[todoId] = it }
    }

    override suspend fun reorder(surfaceId: String, todoId: String, afterId: String?, ifMatch: String, mutationId: String): TodoItem = synchronized(this) {
        reachable()
        writes += Write("REORDER", todoId, mutationId, afterId ?: "first")
        val todo = check(todoId, ifMatch)
        val rest = active().filter { it.id != todoId }
        val index = afterId?.let { id -> rest.indexOfFirst { it.id == id }.takeIf { it >= 0 }?.plus(1) } ?: 0
        val key = TodoOrder.key(if (index > 0) rest[index - 1].orderKey else null, if (index < rest.size) rest[index].orderKey else null)
        todo.copy(orderKey = key, version = version()).also { todos[todoId] = it }
    }

    override suspend fun versions(surfaceId: String, todoId: String): List<TodoRevision> = emptyList()

    override suspend fun names(ids: List<String>): Map<String, String> = ids.associateWith { "Person $it" }
}

/** iOS's TodoLibraryTests, against the fake computer, with the same scenarios. */
class TodoLibraryTest {
    private val surfaceId = "s0000000000000000000000a"
    private val a1 = "t000000000000000000000a1"
    private val a2 = "t000000000000000000000a2"
    private val a3 = "t000000000000000000000a3"
    private val scopes = ArrayList<CoroutineScope>()

    /** What a connection keeps between launches. */
    private class Disk : IntentStorage {
        val values = java.util.concurrent.ConcurrentHashMap<String, JsonObject>()
        @Volatile var intents: List<Intent> = emptyList()
        override suspend fun load() = intents
        override suspend fun save(intents: List<Intent>) { this.intents = intents }
    }

    private class Account(val library: TodoLibrary, val outbox: IntentOutbox, val events: MutableSharedFlow<TodoFeedEvent>, val scope: CoroutineScope)

    /** One launch: its outbox and library over [disk]. */
    private fun launch(server: TodoRoutes, disk: Disk, online: Boolean = true): Account {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default).also(scopes::add)
        val outbox = IntentOutbox(scope, disk)
        val library = TodoLibrary(server, outbox, kept = { disk.values[it] }, keep = { key, value -> disk.values[key] = value }, scope = scope)
        val events = MutableSharedFlow<TodoFeedEvent>(extraBufferCapacity = 16)
        library.follow(events)
        outbox.setOnline(online)
        return Account(library, outbox, events, scope)
    }

    private class Watcher { @Volatile var state = TodoListState() }

    private fun watch(account: Account): Watcher {
        val watcher = Watcher()
        account.scope.launch { account.library.states(surfaceId).collect { watcher.state = it } }
        return watcher
    }

    private fun eventually(seconds: Long = 6, condition: () -> Boolean) = runBlocking {
        withTimeout(seconds * 1000) { while (!condition()) delay(10) }
    }

    @After
    fun tearDown() {
        scopes.forEach { it.cancel() }
    }

    @Test
    fun aChangeShowsAtOnceAndReachesTheComputerUnderItsIds() = runBlocking {
        val server = FakeTodoServer(surfaceId)
        server.seed(a1, "Milk")
        val account = launch(server, Disk())
        val watcher = watch(account)
        eventually { watcher.state.active.map { it.text } == listOf("Milk") && !watcher.state.kept }
        account.outbox.setOnline(false)
        val id = account.library.add(surfaceId, "  Bread ")!!
        eventually { watcher.state.active.map { it.text } == listOf("Bread", "Milk") && watcher.state.waiting == setOf(id) }
        val pending = account.outbox.pending.value
        account.outbox.setOnline(true)
        eventually { server.snapshot()[id] != null && watcher.state.waiting.isEmpty() }
        assertEquals("the todo's ID is the creation's retry key", id, server.writeLog().first().todoId)
        assertEquals("the intent's ID is the mutation ID", pending.first().id, server.writeLog().first().mutationId)
        assertEquals(listOf("Bread", "Milk"), watcher.state.active.map { it.text })
        assertFalse("the computer's todo replaced the local one", watcher.state.active[0].version.isEmpty())
    }

    @Test
    fun changesWaitThroughARelaunchAndGoInTheOrderTheyWereMade() = runBlocking {
        val server = FakeTodoServer(surfaceId)
        server.seed(a1, "Milk")
        val disk = Disk()
        val first = launch(server, disk)
        val watcher = watch(first)
        eventually { watcher.state.active.size == 1 && !watcher.state.kept }
        first.outbox.setOnline(false)
        val id = first.library.add(surfaceId, "Bread")!!
        first.library.setText(surfaceId, id, "Rye bread")
        first.library.setDone(surfaceId, a1, true)
        first.scope.cancel()

        // Killed and opened again, offline: what was kept and what waits show.
        server.away = true
        val second = launch(server, disk)
        val again = watch(second)
        eventually { again.state.active.map { it.text } == listOf("Rye bread") && again.state.completed.map { it.text } == listOf("Milk") }
        server.away = false
        eventually(10) { disk.intents.isEmpty() }
        val writes = server.writeLog().map { "${it.method} ${it.body}" }
        assertEquals(listOf("POST Bread", "PATCH Rye bread"), writes.filter { it != "PATCH completed" })
        assertEquals(setOf("POST Bread", "PATCH Rye bread", "PATCH completed"), writes.toSet())
        assertEquals("Rye bread", server.snapshot()[id]?.text)
        assertEquals(TodoItem.Status.Completed, server.snapshot()[a1]?.status)
    }

    /** Someone changed the todo first: the computer's version is taken and the change made again on top of it. */
    @Test
    fun aConflictTakesTheComputersTodoAndAppliesTheChangeAgain() = runBlocking {
        val server = FakeTodoServer(surfaceId)
        server.seed(a1, "Milk")
        val account = launch(server, Disk())
        val watcher = watch(account)
        eventually { !watcher.state.kept }
        account.outbox.setOnline(false)
        server.elsewhere(a1) { it.copy(text = "Milk (2 l)") }
        account.library.setDone(surfaceId, a1, true)
        account.outbox.setOnline(true)
        eventually { server.snapshot()[a1]?.status == TodoItem.Status.Completed }
        eventually { watcher.state.completed.firstOrNull()?.text == "Milk (2 l)" }
        assertEquals("refused once as stale, then sent again", listOf("PATCH", "PATCH"), server.writeLog().map { it.method })
        assertNull(watcher.state.failure)
    }

    @Test
    fun aChangeToATodoDeletedElsewhereIsDropped() = runBlocking {
        val server = FakeTodoServer(surfaceId)
        server.seed(a1, "Milk")
        val account = launch(server, Disk())
        val watcher = watch(account)
        eventually { !watcher.state.kept }
        account.outbox.setOnline(false)
        server.elsewhere(a1) { it.copy(status = TodoItem.Status.Deleted, orderKey = null, deletedAt = 7.0) }
        account.library.setText(surfaceId, a1, "Oat milk")
        account.outbox.setOnline(true)
        eventually { account.outbox.pending.value.isEmpty() }
        assertEquals("tried once, refused as stale", listOf("PATCH"), server.writeLog().map { it.method })
        eventually { watcher.state.active.isEmpty() }
    }

    @Test
    fun aRefusalUndoesTheChangeAndSaysWhy() = runBlocking {
        val server = FakeTodoServer(surfaceId)
        server.seed(a1, "Milk")
        server.refuseText = "Forbidden"
        val account = launch(server, Disk())
        val watcher = watch(account)
        eventually { !watcher.state.kept }
        account.library.setText(surfaceId, a1, "Forbidden")
        eventually { watcher.state.failure != null }
        assertEquals("That text isn't allowed", watcher.state.failure)
        assertEquals("rolled back", listOf("Milk"), watcher.state.active.map { it.text })
        account.library.dismissFailure(surfaceId)
        eventually { watcher.state.failure == null }
    }

    @Test
    fun anUndoneDeleteComesBackWhereItWas() = runBlocking {
        val server = FakeTodoServer(surfaceId)
        listOf(a1 to "Milk", a2 to "Eggs", a3 to "Bread").forEach { (id, text) -> server.seed(id, text) }
        val account = launch(server, Disk())
        val watcher = watch(account)
        eventually { watcher.state.active.size == 3 && !watcher.state.kept }
        account.library.delete(surfaceId, a2)
        eventually { watcher.state.active.map { it.text } == listOf("Milk", "Bread") }
        eventually { server.snapshot()[a2]?.status == TodoItem.Status.Deleted }
        account.library.restore(surfaceId, a2, TodoLibrary.Place.After(a1))
        eventually { watcher.state.active.map { it.text } == listOf("Milk", "Eggs", "Bread") }
        eventually(10) { account.outbox.pending.value.isEmpty() }
        assertEquals("the computer has it in its place too", listOf("Milk", "Eggs", "Bread"), server.order())
        assertEquals(listOf("DELETE", "PATCH", "REORDER"), server.writeLog().map { it.method })
    }

    @Test
    fun anUndoBeforeTheDeleteIsSentSendsNothing() = runBlocking {
        val server = FakeTodoServer(surfaceId)
        server.seed(a1, "Milk")
        val account = launch(server, Disk())
        val watcher = watch(account)
        eventually { !watcher.state.kept }
        account.outbox.setOnline(false)
        account.library.delete(surfaceId, a1)
        account.library.restore(surfaceId, a1, TodoLibrary.Place.After(null))
        account.outbox.setOnline(true)
        eventually(10) { account.outbox.pending.value.isEmpty() }
        assertEquals(emptyList<FakeTodoServer.Write>(), server.writeLog())
        assertEquals(listOf("Milk"), watcher.state.active.map { it.text })
    }

    @Test
    fun aMoveSendsWhatComesBeforeIt() = runBlocking {
        val server = FakeTodoServer(surfaceId)
        listOf(a1 to "Milk", a2 to "Eggs", a3 to "Bread").forEach { (id, text) -> server.seed(id, text) }
        val account = launch(server, Disk())
        val watcher = watch(account)
        eventually { watcher.state.active.size == 3 && !watcher.state.kept }
        account.library.move(surfaceId, a1, 2)
        eventually { watcher.state.active.map { it.text } == listOf("Eggs", "Bread", "Milk") }
        eventually { account.outbox.pending.value.isEmpty() }
        assertEquals(listOf(a3), server.writeLog().map { it.body })
        assertEquals(listOf("Eggs", "Bread", "Milk"), server.order())
    }

    @Test
    fun eventsFromElsewhereShowAndANewTodoIsRead() = runBlocking {
        val server = FakeTodoServer(surfaceId)
        val before = server.seed(a1, "Milk", author = "u1")
        val account = launch(server, Disk())
        val watcher = watch(account)
        eventually { watcher.state.names == mapOf("u1" to "Person u1") }
        val after = server.elsewhere(a1) { it.copy(text = "Oat milk") }
        account.events.emit(TodoFeedEvent.Event("todo.updated", json(
            """{"surfaceId":"$surfaceId","todoId":"$a1","previousVersion":"${before.version}","version":"${after.version}","changes":{"text":"Oat milk","updatedAt":3}}""",
        )))
        eventually { watcher.state.active.map { it.text } == listOf("Oat milk") }
        // One it never saw: read whole.
        val new = server.seed(a2, "Eggs")
        account.events.emit(TodoFeedEvent.Event("todo.updated", json(
            """{"surfaceId":"$surfaceId","todoId":"$a2","previousVersion":"v000000","version":"${new.version}","changes":{}}""",
        )))
        eventually { watcher.state.active.map { it.text } == listOf("Oat milk", "Eggs") }
    }

    @Test
    fun theDeletedListIsReadWhenAskedFor() = runBlocking {
        val server = FakeTodoServer(surfaceId)
        server.seed(a1, "Milk")
        server.seed(a2, "Old", status = TodoItem.Status.Deleted)
        val account = launch(server, Disk())
        val watcher = watch(account)
        eventually { !watcher.state.kept }
        assertEquals(emptyList<TodoItem>(), watcher.state.deleted)
        account.library.showDeleted(surfaceId)
        eventually { watcher.state.deleted.map { it.text } == listOf("Old") && watcher.state.deletedRead }
        account.library.restore(surfaceId, a2)
        eventually { watcher.state.active.map { it.text } == listOf("Milk", "Old") }
        assertEquals(mapOf(surfaceId to 2), account.library.outstanding(listOf(surfaceId)))
    }

    @Test
    fun indexCountsFollowOfflineChangesAndSurviveWithoutOpeningTheList() = runBlocking {
        val server = FakeTodoServer(surfaceId)
        server.seed(a1, "Milk")
        server.seed(a2, "# Dairy")
        val disk = Disk()
        val account = launch(server, disk)
        val watcher = watch(account)
        eventually { !watcher.state.kept && disk.values.isNotEmpty() }
        server.away = true
        account.outbox.setOnline(false)
        val counts = java.util.concurrent.atomic.AtomicReference<Map<String, Int>>(emptyMap())
        account.scope.launch { account.library.outstandingStates(listOf(surfaceId)).collect(counts::set) }
        eventually { counts.get() == mapOf(surfaceId to 1) }
        account.library.setDone(surfaceId, a1, true)
        eventually { counts.get() == mapOf(surfaceId to 0) && disk.intents.isNotEmpty() }
        account.scope.cancel()
        val restarted = launch(server, disk, online = false)
        eventually { restarted.outbox.pending.value.isNotEmpty() }
        assertEquals(mapOf(surfaceId to 0), restarted.library.outstanding(listOf(surfaceId)))
    }

    @Test
    fun anOlderReadCannotOverwriteAJournalChange() = runBlocking {
        val server = FakeTodoServer(surfaceId)
        val before = server.seed(a1, "Milk")
        val captured = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val routes = object : TodoRoutes by server {
            override suspend fun todos(surfaceId: String, scope: TodoItem.Status): List<TodoItem> {
                val snapshot = server.todos(surfaceId, scope)
                if (scope == TodoItem.Status.Active) {
                    captured.complete(Unit)
                    release.await()
                }
                return snapshot
            }
        }
        val disk = Disk()
        disk.values[TodoLibrary.resource(surfaceId)] = json("""{"todos":[${before.json()}],"read":true}""")
        val account = launch(routes, disk)
        val watcher = watch(account)
        withTimeout(3000) { captured.await() }
        eventually { account.events.subscriptionCount.value > 0 }
        val after = server.elsewhere(a1) { it.copy(text = "Oat milk") }
        account.events.emit(TodoFeedEvent.Event("todo.updated", json(
            """{"surfaceId":"$surfaceId","todoId":"$a1","previousVersion":"${before.version}","version":"${after.version}","changes":{"text":"Oat milk"}}""",
        )))
        eventually { watcher.state.active.singleOrNull()?.text == "Oat milk" }
        release.complete(Unit)
        eventually { !watcher.state.kept }
        assertEquals(listOf("Oat milk"), watcher.state.active.map { it.text })
        assertEquals(after.version, watcher.state.active.single().version)
    }

    @Test
    fun aListOpensOfflineOnWhatWasKept() = runBlocking {
        val server = FakeTodoServer(surfaceId)
        server.seed(a1, "Milk")
        val disk = Disk()
        val first = launch(server, disk)
        val watcher = watch(first)
        eventually { !watcher.state.kept }
        first.scope.cancel()
        server.away = true
        val second = launch(server, disk)
        val again = watch(second)
        eventually { again.state.active.map { it.text } == listOf("Milk") }
        assertEquals(TodoListState.Status.Ready, again.state.status)
        assertEquals("not read this time", true, again.state.kept)
    }

    private fun json(text: String): JsonObject = Json.parseToJsonElement(text).jsonObject
}
