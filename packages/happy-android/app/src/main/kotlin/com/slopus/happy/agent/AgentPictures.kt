package com.slopus.happy.agent

import java.util.concurrent.ConcurrentHashMap

/**
 * Pictures the agent serves (bots' avatars), read once over the tunnel and
 * kept for the session by path and ThumbHash, so a row scrolled back into
 * view draws at once. A changed picture comes with a new ThumbHash and is
 * read again.
 */
class AgentPictures(private val connectionId: String, private val fetch: suspend (path: String) -> ByteArray) {
    private val kept = ConcurrentHashMap<String, ByteArray>()

    /** What [path] at [thumbhash] is kept under, here and in the image loader's memory cache. */
    fun key(path: String, thumbhash: String?) = "agent/$connectionId$path#${thumbhash.orEmpty()}"

    fun kept(path: String, thumbhash: String?): ByteArray? = kept[key(path, thumbhash)]

    suspend fun read(path: String, thumbhash: String?): ByteArray =
        kept(path, thumbhash) ?: fetch(path).also { kept[key(path, thumbhash)] = it }
}
