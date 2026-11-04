package com.slopus.happy.camera

import androidx.annotation.WorkerThread
import java.io.File
import java.io.IOException
import java.util.UUID

/**
 * A sheet's captured files, until Use Photo transfers a directory to the draft.
 * Allocation and deletion run on IO. Transfer only updates ownership in memory.
 * Discarded directories stay known: a CameraX callback finishing after disposal
 * can delete its late output again without touching a photo already handed over.
 */
internal class PhotoFiles(private val root: File) {
    private enum class Ownership { Held, Discarded, Transferred }
    private val directories = LinkedHashMap<File, Ownership>()
    private var closed = false

    @WorkerThread
    @Synchronized
    fun allocate(): File {
        check(!closed) { "The camera's sheet has closed" }
        val directory = File(root, UUID.randomUUID().toString())
        if (!directory.mkdirs() && !directory.isDirectory) throw IOException("Cannot create capture directory")
        directories[directory] = Ownership.Held
        return directory
    }

    @Synchronized
    fun holds(directory: File): Boolean = !closed && directories[directory] == Ownership.Held

    /** Use Photo: from this point only the draft owns the normalized attachment. */
    @Synchronized
    fun transfer(directory: File): Boolean {
        if (!holds(directory)) return false
        directories[directory] = Ownership.Transferred
        return true
    }

    @WorkerThread
    fun discard(directory: File) {
        val remove = synchronized(this) {
            when (directories[directory]) {
                null, Ownership.Transferred -> false
                else -> { directories[directory] = Ownership.Discarded; true }
            }
        }
        if (remove) directory.deleteRecursively()
    }

    @WorkerThread
    fun close() {
        val abandoned = synchronized(this) {
            closed = true
            directories.filterValues { it != Ownership.Transferred }.keys.toList().also { paths ->
                paths.forEach { directories[it] = Ownership.Discarded }
            }
        }
        abandoned.forEach(File::deleteRecursively)
    }
}
