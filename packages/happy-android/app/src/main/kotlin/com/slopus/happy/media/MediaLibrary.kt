package com.slopus.happy.media

import java.io.File

/**
 * One account's kept media (iOS `MediaLibrary`): its [store] and the
 * [downloads] that fill it, with the [board] its tiles read. An agent
 * connection's session makes one beside its kept catalog, so it goes with
 * the connection.
 */
class MediaLibrary(directory: File) {
    val store = MediaStore(directory)
    val board = DownloadBoard()
    val downloads = MediaDownloads(store, board)

    /** The bytes kept; reads the disk. */
    fun usage(): Long = store.usage()

    /** Clear Media: every file of this account's, and every ring back to where nothing is here. */
    suspend fun clear() = downloads.removeAll()

    /** The account went: its reads stop, its folder goes with the rest it kept. */
    suspend fun stop() = downloads.stop()
}
