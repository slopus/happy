package com.slopus.happy.vaults

import com.slopus.happy.agent.AgentEvent
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.text.Collator
import java.util.Locale

internal fun vaultItem(
    id: String,
    version: String,
    name: String = id,
    parentId: String? = null,
    kind: String = VaultItem.FILE,
    size: Long? = null,
    updatedAt: Long = 0,
    mediaType: String? = null,
    surfaceId: String = "s1",
) = VaultItem(id = id, surfaceId = surfaceId, parentId = parentId, name = name, kind = kind, size = size, updatedAt = updatedAt, mediaType = mediaType, version = version)

private fun changes(vararg pairs: Pair<String, Any?>) = JsonObject(
    pairs.associate { (key, value) ->
        key to when (value) {
            null -> JsonNull
            is String -> JsonPrimitive(value)
            is Number -> JsonPrimitive(value)
            else -> error("unsupported")
        }
    },
)

class VaultListingTest {
    @Test
    fun updatesFollowTheVersionChain() {
        val listing = VaultListing("s1", null)
        listing.page(listOf(vaultItem("a", "0002", "a.txt")))
        val rename = VaultEvent.Updated("s1", "a", "0002", "0003", changes("name" to "b.txt"))
        assertEquals(VaultListing.Outcome.Changed, listing.receive(rename))
        assertEquals("b.txt", listing["a"]?.name)
        assertEquals("0003", listing["a"]?.version)
        // The same event again, and an older one, change nothing.
        assertEquals(VaultListing.Outcome.Ignored, listing.receive(rename))
        assertEquals(VaultListing.Outcome.Ignored, listing.receive(VaultEvent.Updated("s1", "a", "0001", "0002", changes("name" to "old"))))
        // A gap in the chain reads the entry again.
        assertEquals(VaultListing.Outcome.Read("a"), listing.receive(VaultEvent.Updated("s1", "a", "0004", "0005", changes("name" to "c.txt"))))
        assertEquals("b.txt", listing["a"]?.name)
        // Another vault's events are not this folder's.
        assertEquals(VaultListing.Outcome.Ignored, listing.receive(VaultEvent.Updated("s2", "a", "0003", "0004", changes("name" to "x"))))
    }

    @Test
    fun anEntryThatLeftIsNotBroughtBackByAnOlderPage() {
        val listing = VaultListing("s1", "f1")
        listing.page(listOf(vaultItem("a", "0002", parentId = "f1")))
        assertEquals(VaultListing.Outcome.Changed, listing.receive(VaultEvent.Updated("s1", "a", "0002", "0003", changes("parentId" to "f2"))))
        assertNull(listing["a"])
        assertFalse(listing.page(listOf(vaultItem("a", "0002", parentId = "f1"))))
        assertNull(listing["a"])
        // Moved back later, at a newer version: it is here again.
        assertTrue(listing.page(listOf(vaultItem("a", "0004", parentId = "f1"))))
        assertEquals("0004", listing["a"]?.version)
    }

    @Test
    fun deletionsRestoresAndArrivals() {
        val listing = VaultListing("s1", null)
        listing.page(listOf(vaultItem("a", "0001")))
        val deleted = VaultEvent.Updated("s1", "a", "0001", "0002", changes("deletedAt" to 5))
        assertEquals(VaultListing.Outcome.Changed, listing.receive(deleted))
        assertTrue(listing.entries.isEmpty())
        // Restored, or moved in from elsewhere: the event doesn't say everything, so the entry is read.
        assertEquals(VaultListing.Outcome.Read("a"), listing.receive(VaultEvent.Updated("s1", "a", "0002", "0003", changes("deletedAt" to null))))
        assertEquals(VaultListing.Outcome.Read("b"), listing.receive(VaultEvent.Updated("s1", "b", "0001", "0002", changes("parentId" to null))))
        assertEquals(VaultListing.Outcome.Ignored, listing.receive(VaultEvent.Updated("s1", "c", "0001", "0002", changes("parentId" to "f9"))))
        assertTrue(listing.read("a", vaultItem("a", "0003")))
        assertEquals(listOf("a"), listing.entries.map { it.id })
        assertEquals(VaultListing.Outcome.Changed, listing.receive(VaultEvent.Created(vaultItem("n", "0001", "new"))))
        assertEquals(VaultListing.Outcome.Ignored, listing.receive(VaultEvent.Created(vaultItem("m", "0001", parentId = "f1"))))
        assertEquals(VaultListing.Outcome.Changed, listing.receive(VaultEvent.Removed("s1", "n")))
        assertFalse(listing.page(listOf(vaultItem("n", "0009"))))
    }

    @Test
    fun aWholeReadDropsWhatNoPageListedUnlessAnEventSettledIt() {
        val listing = VaultListing("s1", null)
        listing.page(listOf(vaultItem("a", "0001"), vaultItem("b", "0001"), vaultItem("c", "0001")))
        listing.begin()
        listing.page(listOf(vaultItem("a", "0001")))
        listing.receive(VaultEvent.Created(vaultItem("d", "0001")))
        listing.receive(VaultEvent.Updated("s1", "b", "0001", "0002", changes("name" to "b2")))
        assertTrue(listing.finish())
        assertEquals(setOf("a", "b", "d"), listing.entries.map { it.id }.toSet())
        // A read that failed part way drops nothing.
        listing.begin()
        listing.page(emptyList())
        listing.abandon()
        assertEquals(3, listing.entries.size)
    }

    @Test
    fun theFolderGoingAndAReconnect() {
        val listing = VaultListing("s1", "f1")
        assertEquals(VaultListing.Outcome.Gone, listing.receive(VaultEvent.Removed("s1", "f1")))
        assertEquals(VaultListing.Outcome.Reload, listing.receive(VaultEvent.Resync))
    }

    @Test
    fun foldersComeFirstThenTheChosenOrder() {
        val collator = Collator.getInstance(Locale.ENGLISH).apply { strength = Collator.SECONDARY }
        val entries = listOf(
            vaultItem("1", "1", "b.txt", size = 10, updatedAt = 3),
            vaultItem("2", "1", "A.txt", size = 30, updatedAt = 1),
            vaultItem("3", "1", "zeta", kind = VaultItem.FOLDER, updatedAt = 2),
            vaultItem("4", "1", "Élan.txt", size = 20, updatedAt = 2),
            vaultItem("5", "1", "alpha", kind = VaultItem.FOLDER, updatedAt = 9),
        )
        fun order(sort: VaultSort) = entries.sortedWith(sort.comparator(collator)).map { it.name }
        assertEquals(listOf("alpha", "zeta", "A.txt", "b.txt", "Élan.txt"), order(VaultSort()))
        assertEquals(listOf("zeta", "alpha", "Élan.txt", "b.txt", "A.txt"), order(VaultSort(VaultSortField.Name, descending = true)))
        assertEquals(listOf("alpha", "zeta", "A.txt", "Élan.txt", "b.txt"), order(VaultSort(VaultSortField.Size, descending = true)))
        assertEquals(listOf("alpha", "zeta", "b.txt", "Élan.txt", "A.txt"), order(VaultSort(VaultSortField.Updated, descending = true)))
    }

    @Test
    fun pickingTheSameFieldTurnsItsOrderRound() {
        assertEquals(VaultSort(VaultSortField.Name, descending = true), VaultSort().picking(VaultSortField.Name))
        assertEquals(VaultSort(VaultSortField.Updated, descending = true), VaultSort().picking(VaultSortField.Updated))
        assertEquals(VaultSort(VaultSortField.Updated, descending = false), VaultSort(VaultSortField.Updated, true).picking(VaultSortField.Updated))
        assertEquals(VaultSort(VaultSortField.Name, descending = false), VaultSort(VaultSortField.Size, true).picking(VaultSortField.Name))
    }
}

class VaultEventsTest {
    private fun event(type: String, json: String) = AgentEvent("c1", type, Json.parseToJsonElement(json).jsonObject)

    @Test
    fun theJournalsVaultEventsRead() {
        val created = VaultEvent.of(event("vault.file.created", """{"file":{"id":"e1","surfaceId":"s1","parentId":null,"name":"a.txt","kind":"file","latestVersion":1,"size":3,"createdAt":1,"createdBy":{"userId":"u1","agentId":null},"updatedAt":1,"updatedBy":{"userId":"u1"},"deletedAt":null,"version":"v1","future":true}}"""))
        assertEquals("a.txt", (created as VaultEvent.Created).item.name)
        assertEquals("u1", created.item.createdBy.userId)
        val updated = VaultEvent.of(event("vault.file.updated", """{"surfaceId":"s1","fileId":"e1","previousVersion":"v1","version":"v2","changes":{"name":"b.txt"}}"""))
        assertEquals(VaultEvent.Updated("s1", "e1", "v1", "v2", changes("name" to "b.txt")), updated)
        assertEquals(VaultEvent.Removed("s1", "e1"), VaultEvent.of(event("vault.file.removed", """{"surfaceId":"s1","fileId":"e1"}""")))
        assertEquals(VaultEvent.VersionPinned("s1", "e1", 4, true), VaultEvent.of(event("vault.version.updated", """{"surfaceId":"s1","fileId":"e1","number":4,"pinned":true}""")))
        assertEquals(VaultEvent.SettingsUpdated("s1"), VaultEvent.of(event("vault.settings.updated", """{"surfaceId":"s1","settings":{}}""")))
        assertEquals(VaultEvent.Resync, VaultEvent.of(event(AgentEvent.HELLO, "{}")))
        assertNull(VaultEvent.of(event("vault.file.updated", """{"surfaceId":"s1"}""")))
        assertNull(VaultEvent.of(event("todo.created", "{}")))
        val folder = VaultEvent.of(event("vault.folder.updated", """{"surfaceId":"s1","folderId":"f1","previousVersion":"v1","version":"v2","changes":{"deletedAt":5}}"""))
        assertEquals(true, (folder as VaultEvent.Updated).folder)
        assertEquals("f1", folder.itemId)
        assertEquals(VaultEvent.Removed("s1", "f1", folder = true), VaultEvent.of(event("vault.folder.removed", """{"surfaceId":"s1","folderId":"f1"}""")))
        assertEquals(true, (VaultEvent.of(event("vault.folder.created", """{"folder":{"id":"f1","surfaceId":"s1","name":"Q3","kind":"folder","version":"v1"}}""")) as VaultEvent.Created).item.isFolder)
    }

    @Test
    fun changesAreLaidOverTheEntry() {
        val entry = vaultItem("e1", "v1", "a.txt", size = 3, mediaType = "text/plain")
        val next = entry.changed(Json.parseToJsonElement("""{"name":"b.md","size":9,"latestVersion":2,"deletedAt":7}""").jsonObject, "v2")!!
        assertEquals(entry.copy(name = "b.md", size = 9, latestVersion = 2, deletedAt = 7, version = "v2"), next)
        val restored = next.changed(changes("deletedAt" to null, "parentId" to "f1"), "v3")!!
        assertNull(restored.deletedAt)
        assertEquals("f1", restored.parentId)
        assertNull(entry.changed(changes("name" to null), "v2"))
    }

    @Test
    fun versionsSortByTime() {
        assertTrue(VaultVersions.newer("019A5E00-0000-7000-8000-000000000002", "019a5e00-0000-7000-8000-000000000001"))
        assertFalse(VaultVersions.newer("v1", "v1"))
    }
}
