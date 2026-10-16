package com.slopus.happy.projects

import com.slopus.happy.crypto.AccountEncryption
import com.slopus.happy.crypto.PayloadCipher
import com.slopus.happy.crypto.decryptBlob
import com.slopus.happy.crypto.encodeBase64
import com.slopus.happy.model.Project
import com.slopus.happy.model.ProjectAvatar
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** The project's avatar as the record describes it; its preview already decrypted. */
data class ProjectAvatarDescriptor(val ref: String, val version: Long, val thumbhash: String, val mimeType: String) {
    /** sync.ts avatarDescriptorKey */
    val key: String get() = "$ref:$version:$thumbhash:$mimeType"
}

/** projects.ts `DecryptedProjectRecord`. The data key never leaves this package. */
class DecryptedProject(val project: Project, internal val dataKey: ByteArray?, val avatar: ProjectAvatarDescriptor?)

private val MIME_TYPE = Regex("^image/[A-Za-z0-9.+-]+$")

private fun JsonObject.nonEmpty(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content?.trim()?.ifEmpty { null }

/**
 * projects.ts decryptProjectRecord. A record with a data key opens with
 * it; one without (the legacy form) with the account secretbox. A key
 * that won't unwrap, or metadata without a name, is no project. A preview
 * that won't open is no avatar.
 */
fun decryptProjectRecord(record: ApiProjectRecord, encryption: AccountEncryption): DecryptedProject? {
    val dataKey = record.dataEncryptionKey?.let { encryption.decryptDataEncryptionKey(it) ?: return null }
    val cipher: PayloadCipher = dataKey?.let(encryption::dataKeyCipher) ?: encryption.settingsCipher()
    val metadata = runCatching { cipher.decryptFromBase64(record.metadata) }.getOrNull() as? JsonObject ?: return null
    val name = metadata.nonEmpty("name") ?: return null
    val avatar = record.avatar?.let { avatar ->
        val preview = runCatching { cipher.decryptFromBase64(avatar.preview) }.getOrNull() as? JsonObject
        val thumbhash = preview?.nonEmpty("thumbhash")
        val mimeType = preview?.nonEmpty("mimeType")?.takeIf(MIME_TYPE::matches)
        if (thumbhash != null && mimeType != null) ProjectAvatarDescriptor(avatar.ref, avatar.version, thumbhash, mimeType) else null
    }
    return DecryptedProject(
        Project(
            id = record.id,
            externalId = record.externalId,
            name = name,
            kind = metadata.nonEmpty("kind"),
            metadataVersion = record.metadataVersion,
            avatar = null,
            createdAt = record.createdAt,
            updatedAt = record.updatedAt,
        ),
        dataKey,
        avatar,
    )
}

/**
 * sync.ts fetchProjects and hydrateProjectAvatar for one account: the
 * projects the stored sessions name, decrypted, published at once, then
 * each avatar downloaded and decrypted into a data URI. Avatars are
 * cached by project and descriptor; a changed descriptor or data key
 * drops the old one. A failed avatar leaves the name usable.
 *
 * [refresh] is not reentrant: run it from one InvalidateSync. A refresh
 * applies only the avatars of the descriptors it published itself.
 */
class ProjectCatalog(
    private val encryption: AccountEncryption,
    private val fetch: suspend (projectIds: Collection<String>) -> List<ApiProjectRecord>,
    private val downloadAvatar: suspend (projectId: String) -> ByteArray,
) {
    private val state = MutableStateFlow<Map<String, Project>>(emptyMap())

    /** Decrypted projects by id, with their avatars once loaded. */
    val projects: StateFlow<Map<String, Project>> = state.asStateFlow()

    private val dataKeys = HashMap<String, ByteArray?>()
    private val descriptors = HashMap<String, String>()
    private val avatars = HashMap<String, ProjectAvatar>()

    suspend fun refresh(projectIds: Collection<String>) {
        val records = fetch(projectIds).mapNotNull { record ->
            try {
                decryptProjectRecord(record, encryption)
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                null
            }
        }
        val current = records.map { it.project.id }.toSet()
        for (id in dataKeys.keys.toList()) {
            if (id in current) continue
            dataKeys.remove(id)
            descriptors.remove(id)
            clearAvatars(id)
        }
        val expected = HashSet<String>()
        for (record in records) {
            val id = record.project.id
            val next = record.avatar?.key
            if (descriptors[id] != next) clearAvatars(id)
            if (next != null) {
                descriptors[id] = next
                expected += "$id:$next"
            } else {
                descriptors.remove(id)
            }
            if (dataKeys.containsKey(id) && !dataKeys[id].contentEqualsNullable(record.dataKey)) clearAvatars(id)
            dataKeys[id] = record.dataKey
        }
        avatars.keys.retainAll(expected)

        // The catalog is visible before any artwork arrives.
        state.value = records.associate { record ->
            val id = record.project.id
            id to record.project.copy(avatar = record.avatar?.let { avatars["$id:${it.key}"] })
        }
        // Downloads run side by side; what they bring is applied here, one at a time.
        val loaded = coroutineScope {
            records.mapNotNull { record ->
                val descriptor = record.avatar ?: return@mapNotNull null
                if (avatars.containsKey("${record.project.id}:${descriptor.key}")) return@mapNotNull null
                async { Triple(record, descriptor, load(record, descriptor)) }
            }.awaitAll()
        }
        for ((record, descriptor, avatar) in loaded) {
            avatar ?: continue
            val id = record.project.id
            avatars["$id:${descriptor.key}"] = avatar
            val project = state.value[id] ?: continue
            state.value = state.value + (id to project.copy(avatar = avatar))
        }
    }

    private suspend fun load(record: DecryptedProject, descriptor: ProjectAvatarDescriptor): ProjectAvatar? = try {
        val blobKey = record.dataKey?.let(AccountEncryption::blobKeyForDataKey) ?: encryption.masterBlobKey
        val bytes = decryptBlob(downloadAvatar(record.project.id), blobKey)
        bytes?.let {
            ProjectAvatar(descriptor.ref, descriptor.version, descriptor.mimeType, descriptor.thumbhash, "data:${descriptor.mimeType};base64,${encodeBase64(it)}")
        }
    } catch (e: CancellationException) {
        throw e
    } catch (_: Exception) {
        null
    }

    private fun clearAvatars(projectId: String) {
        avatars.keys.removeAll { it.startsWith("$projectId:") }
    }
}

private fun ByteArray?.contentEqualsNullable(other: ByteArray?): Boolean =
    if (this == null || other == null) this === other else contentEquals(other)
