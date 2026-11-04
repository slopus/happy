package com.slopus.happy.todos

import com.slopus.happy.agent.Intent
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** iOS's TodoTextTests, TodoOrderTests and TodoReducerTests, with the same cases. */
class TodoReducerTest {
    private val s = "s0000000000000000000000a"

    private fun todo(id: String, text: String = "x", status: TodoItem.Status = TodoItem.Status.Active, key: String? = "5", version: String = "0001") = TodoItem(
        id = id, surfaceId = s, text = text, status = status,
        orderKey = if (status == TodoItem.Status.Active) key else null,
        completedAt = if (status == TodoItem.Status.Completed) 10.0 else null,
        deletedAt = if (status == TodoItem.Status.Deleted) 20.0 else null,
        version = version,
    )

    private fun op(id: String, kind: TodoOp.Kind, at: Double = 100.0) = TodoOp(s, id, kind, at)

    private fun json(text: String): JsonObject = Json.parseToJsonElement(text).jsonObject

    @Test
    fun textIsTrimmedAndControlCharactersBecomeSpaces() {
        assertEquals("Buy milk", TodoText.normalized("  Buy\u0007milk \n"))
        assertNull(TodoText.normalized("   \n\t"))
        assertNull(TodoText.normalized("# "))
        assertEquals(10_000, TodoText.normalized("a".repeat(10_050))?.length)
    }

    @Test
    fun aHeadingStaysOneAndATodoNeverBecomesOne() {
        assertEquals("# Groceries", TodoText.normalized("#   Groceries  "))
        assertEquals("Groceries", TodoText.heading("# Groceries"))
        assertEquals(" # milk", TodoText.normalized("  # milk"))
        assertNull(TodoText.heading(" # milk"))
        for (text in listOf("## Title", "#Title", "#\tTitle")) assertNull(text, TodoText.heading(text))
    }

    @Test
    fun keysFallBetweenTheirNeighboursByBytes() {
        val cases = listOf(null to null, null to "5", null to "0", "5" to null, "9" to null, "4" to "5", "44" to "45", "45" to "5", "1" to "2", "09" to "1")
        for ((a, b) in cases) {
            val key = TodoOrder.key(a, b)
            if (a != null) assertTrue("$a < $key", TodoOrder.precedes(a, key))
            if (b != null) assertTrue("$key < $b", TodoOrder.precedes(key, b))
        }
        assertEquals("4", TodoOrder.key(null, null))
        assertEquals("44", TodoOrder.key("4", "5"))
    }

    @Test
    fun listsSortAsTheComputerSortsThem() {
        val a = TodoItem("b", "s", "", orderKey = "5")
        val b = TodoItem("a", "s", "", orderKey = "5")
        val c = TodoItem("c", "s", "", orderKey = "45")
        assertEquals(listOf("c", "a", "b"), listOf(a, b, c).sortedWith(TodoOrder.active).map { it.id })
        assertTrue(TodoOrder.newer("01991f3a-5c1e-7000-8000-2f9a1b3c4d5f", "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e"))
    }

    @Test
    fun anOpRoundTripsThroughItsIntent() {
        val kinds = listOf(
            TodoOp.Kind.Create("a", "4"), TodoOp.Kind.Text("b"), TodoOp.Kind.Status(TodoItem.Status.Completed),
            TodoOp.Kind.Status(TodoItem.Status.Active, "7"), TodoOp.Kind.Move("3"),
        )
        for (kind in kinds) {
            val original = op("t1", kind)
            val intent = Intent("i1", original.intentKind, "t1", original.value, 5)
            assertEquals(original, TodoOp.of(intent))
        }
        assertNull(TodoOp.of(Intent("i2", "read", "a", JsonObject(emptyMap()), 1)))
    }

    @Test
    fun pendingChangesLieOverWhatTheComputerSaid() {
        val confirmed = mapOf("a" to todo("a", "Milk", key = "3"), "b" to todo("b", "Eggs", key = "6"))
        val ops = listOf(
            op("n", TodoOp.Kind.Create("Bread", "1")),
            op("a", TodoOp.Kind.Text("Oat milk")),
            op("b", TodoOp.Kind.Status(TodoItem.Status.Completed), at = 150.0),
            op("n", TodoOp.Kind.Text("Rye bread")),
        )
        val split = TodoReducer.split(TodoReducer.overlay(confirmed, ops))
        assertEquals(listOf("Rye bread", "Oat milk"), split.active.map { it.text })
        assertEquals(listOf("Eggs"), split.completed.map { it.text })
        assertEquals(150.0, split.completed.first().completedAt)
        assertNull(split.completed.first().orderKey)
    }

    @Test
    fun deleteThenRestoreAndMovesKeepTheirPlace() {
        var shown = mapOf("a" to todo("a", key = "3"), "b" to todo("b", key = "6"))
        shown = TodoReducer.overlay(shown, listOf(op("a", TodoOp.Kind.Status(TodoItem.Status.Deleted))))
        assertEquals(TodoItem.Status.Deleted, shown["a"]?.status)
        assertEquals(100.0, shown["a"]?.deletedAt)
        shown = TodoReducer.overlay(shown, listOf(op("a", TodoOp.Kind.Status(TodoItem.Status.Active, "2"))))
        assertEquals(listOf("a", "b"), TodoReducer.split(shown).active.map { it.id })
        assertNull(shown["a"]?.deletedAt)
        shown = TodoReducer.overlay(shown, listOf(op("a", TodoOp.Kind.Move("7"))))
        assertEquals(listOf("b", "a"), TodoReducer.split(shown).active.map { it.id })
    }

    @Test
    fun onlyANewerTodoIsTaken() {
        val confirmed = mutableMapOf("a" to todo("a", "New", version = "0003"))
        assertFalse(TodoReducer.accept(todo("a", "Old", version = "0002"), confirmed))
        assertFalse(TodoReducer.accept(todo("a", "Same", version = "0003"), confirmed))
        assertTrue(TodoReducer.accept(todo("a", "Newer", version = "0004"), confirmed))
        assertEquals("Newer", confirmed["a"]?.text)
    }

    @Test
    fun eventsFollowTheVersionChainAndAskForAReadWhereItBreaks() {
        val confirmed = mutableMapOf("a" to todo("a", "Milk", version = "0001"))
        fun updated(id: String, previous: String, version: String, changes: String, surface: String = s) =
            json("""{"surfaceId":"$surface","todoId":"$id","previousVersion":"$previous","version":"$version","changes":$changes}""")
        assertEquals(
            TodoReducer.EventResult.Applied,
            TodoReducer.receive("todo.updated", updated("a", "0001", "0002", """{"status":"completed","orderKey":null,"completedAt":50,"updatedAt":50}"""), s, confirmed),
        )
        assertEquals(TodoItem.Status.Completed, confirmed["a"]?.status)
        assertNull(confirmed["a"]?.orderKey)
        assertEquals("0002", confirmed["a"]?.version)
        assertEquals(TodoReducer.EventResult.Ignored, TodoReducer.receive("todo.updated", updated("a", "0001", "0002", """{"text":"dup"}"""), s, confirmed))
        assertEquals(TodoReducer.EventResult.Read("a"), TodoReducer.receive("todo.updated", updated("a", "0003", "0004", """{"text":"gap"}"""), s, confirmed))
        assertEquals(TodoReducer.EventResult.Read("z"), TodoReducer.receive("todo.updated", updated("z", "0001", "0002", "{}"), s, confirmed))
        assertEquals(TodoReducer.EventResult.Ignored, TodoReducer.receive("todo.updated", updated("a", "0002", "0003", "{}", surface = "other"), s, confirmed))
        val created = json(
            """{"todo":{"id":"b","surfaceId":"$s","text":"Eggs","status":"active","orderKey":"1","createdAt":1,"updatedAt":1,
               "completedAt":null,"deletedAt":null,"version":"0001","authorUserId":"u1"}}""",
        )
        assertEquals(TodoReducer.EventResult.Applied, TodoReducer.receive("todo.created", created, s, confirmed))
        assertEquals("u1", confirmed["b"]?.authorUserId)
    }

    @Test
    fun aChangeTheComputerAlreadyHasIsNotSent() {
        val confirmed = mapOf("a" to todo("a", "Milk", key = "3"), "b" to todo("b", key = "6"), "d" to todo("d", "x", TodoItem.Status.Deleted))
        assertFalse(TodoReducer.needed(op("a", TodoOp.Kind.Text("Milk")), confirmed, confirmed))
        assertTrue(TodoReducer.needed(op("a", TodoOp.Kind.Text("Oat milk")), confirmed, confirmed))
        assertFalse(TodoReducer.needed(op("a", TodoOp.Kind.Create("Milk", "1")), confirmed, confirmed))
        assertTrue(TodoReducer.needed(op("n", TodoOp.Kind.Create("New", "1")), confirmed, confirmed))
        assertFalse(TodoReducer.needed(op("d", TodoOp.Kind.Text("edit a deleted one")), confirmed, confirmed))
        assertTrue(TodoReducer.needed(op("d", TodoOp.Kind.Status(TodoItem.Status.Active, "9")), confirmed, confirmed))
        assertFalse(TodoReducer.needed(op("d", TodoOp.Kind.Status(TodoItem.Status.Deleted)), confirmed, confirmed))
        val moved = TodoReducer.overlay(confirmed, listOf(op("a", TodoOp.Kind.Move("7"))))
        assertTrue(TodoReducer.needed(op("a", TodoOp.Kind.Move("7")), confirmed, moved))
        val same = TodoReducer.overlay(confirmed, listOf(op("a", TodoOp.Kind.Move("2"))))
        assertFalse(TodoReducer.needed(op("a", TodoOp.Kind.Move("2")), confirmed, same))
        assertEquals("b", TodoReducer.after("a", moved))
        assertNull(TodoReducer.after("b", moved))
    }

    @Test
    fun aMoveFindsAKeyBetweenItsNewNeighbours() {
        val active = listOf(todo("a", key = "2"), todo("b", key = "4"), todo("c", key = "6"))
        val key = TodoReducer.key("a", 2, active)!!
        assertTrue(TodoOrder.precedes("6", key))
        val middle = TodoReducer.key("c", 1, active)!!
        assertTrue(TodoOrder.precedes("2", middle) && TodoOrder.precedes(middle, "4"))
        assertNull("already there", TodoReducer.key("b", 1, active))
    }

    @Test
    fun eachRevisionSaysWhatItChanged() {
        fun revision(text: String, status: TodoItem.Status, key: String? = "5") = TodoRevision(todo("a", text, status, key))
        val changes = TodoRevision.changes(listOf(
            revision("Milk", TodoItem.Status.Active), revision("Oat milk", TodoItem.Status.Active), revision("Oat milk", TodoItem.Status.Completed),
            revision("Oat milk", TodoItem.Status.Active), revision("Oat milk", TodoItem.Status.Active, key = "9"), revision("Oat milk", TodoItem.Status.Deleted),
            revision("Soy milk", TodoItem.Status.Active),
        ))
        assertEquals(
            listOf(
                TodoRevision.Change.Created, TodoRevision.Change.Edited("Milk"), TodoRevision.Change.Completed, TodoRevision.Change.Reopened,
                TodoRevision.Change.Moved, TodoRevision.Change.Deleted, TodoRevision.Change.EditedAnd(TodoRevision.Change.Restored),
            ),
            changes,
        )
    }

    @Test
    fun aTodoRoundTripsThroughItsKeptForm() {
        val original = TodoItem("t", s, "# Dairy", TodoItem.Status.Completed, null, "u1", 1.0, 2.0, 3.0, null, "0009")
        assertEquals(original, TodoItem.parse(original.json()))
    }
}
