package com.slopus.happy.vaults

import com.slopus.happy.agent.AgentEvent
import com.slopus.happy.chat.bool
import com.slopus.happy.chat.num
import com.slopus.happy.chat.obj
import com.slopus.happy.chat.str
import kotlinx.serialization.json.JsonObject

/**
 * What the journal says about vaults (API.md, "Vault Surfaces" › Events),
 * plus [Resync]: after a reconnect, whatever is shown is read again. An
 * item a request of this phone's answered with is [Known], so a screen
 * shows it before its event comes.
 */
sealed interface VaultEvent {
    val surfaceId: String?

    data object Resync : VaultEvent {
        override val surfaceId: String? get() = null
    }

    data class Created(val item: VaultItem) : VaultEvent {
        override val surfaceId: String get() = item.surfaceId
    }

    /** A folder's ([folder]) or a file's fields changed, from [previousVersion] to [version]. */
    data class Updated(
        override val surfaceId: String,
        val itemId: String,
        val previousVersion: String?,
        val version: String,
        val changes: JsonObject,
        val folder: Boolean = false,
    ) : VaultEvent

    /** A Trash item gone for good; a folder with everything inside it. */
    data class Removed(override val surfaceId: String, val itemId: String, val folder: Boolean = false) : VaultEvent

    data class VersionPinned(override val surfaceId: String, val fileId: String, val number: Int, val pinned: Boolean) : VaultEvent

    data class SettingsUpdated(override val surfaceId: String) : VaultEvent

    data class Known(val item: VaultItem) : VaultEvent {
        override val surfaceId: String get() = item.surfaceId
    }

    companion object {
        /** [event] as a vault event; null for any other kind and for one that doesn't read. */
        fun of(event: AgentEvent): VaultEvent? {
            val data = event.data
            return when (event.type) {
                AgentEvent.HELLO -> Resync
                "vault.folder.created" -> VaultItem.parse(data["folder"])?.let(::Created)
                "vault.file.created" -> VaultItem.parse(data["file"])?.let(::Created)
                "vault.folder.updated", "vault.file.updated" -> {
                    val folder = event.type == "vault.folder.updated"
                    Updated(
                        surfaceId = data["surfaceId"].str ?: return null,
                        itemId = data[if (folder) "folderId" else "fileId"].str ?: return null,
                        previousVersion = data["previousVersion"].str,
                        version = data["version"].str ?: return null,
                        changes = data["changes"].obj ?: JsonObject(emptyMap()),
                        folder = folder,
                    )
                }
                "vault.folder.removed" -> Removed(data["surfaceId"].str ?: return null, data["folderId"].str ?: return null, folder = true)
                "vault.file.removed" -> Removed(data["surfaceId"].str ?: return null, data["fileId"].str ?: return null)
                "vault.version.updated" -> VersionPinned(
                    data["surfaceId"].str ?: return null,
                    data["fileId"].str ?: return null,
                    data["number"].num?.toInt() ?: return null,
                    data["pinned"].bool ?: return null,
                )
                "vault.settings.updated" -> SettingsUpdated(data["surfaceId"].str ?: return null)
                else -> null
            }
        }
    }
}

/** Resource versions are UUIDv7s, which sort by time. */
object VaultVersions {
    fun newer(a: String, than: String): Boolean = compare(a, than) > 0

    private fun compare(a: String, b: String): Int = a.lowercase().compareTo(b.lowercase())
}
