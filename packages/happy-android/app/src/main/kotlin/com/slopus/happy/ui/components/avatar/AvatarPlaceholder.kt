package com.slopus.happy.ui.components.avatar

/**
 * happy-ios's AvatarPlaceholder.swift: the picture someone or something
 * without one of its own wears (a person, an account, an agent connection,
 * a bot, a task, a chat, a project). One of the 200 still shader avatars
 * from shaders.craftedstudios.co bundled in `assets/avatar-placeholders`
 * (copied from happy-ios by `tools/avatars/generate.mjs`), picked by a hash
 * of its ID alone, so the same ID wears the same picture on every launch,
 * every device and both phones.
 */
object AvatarPlaceholder {
    /** How many pictures are bundled: the site's wall, five effects of 40. */
    const val COUNT = 200

    const val ASSET_DIR = "avatar-placeholders"

    /** The bundled file's name, without its `webp` extension. */
    fun name(index: Int): String = "avatar-placeholder-%03d".format(index + 1)

    fun asset(index: Int): String = "$ASSET_DIR/${name(index)}.webp"

    /** Which picture [seed] wears. */
    fun index(seed: String): Int = (hash(seed).toLong() and 0xFFFF_FFFFL).rem(COUNT).toInt()

    fun name(seed: String): String = name(index(seed))

    /**
     * What an account's placeholder moves as with Animated Avatars on
     * (happy-ios's `ProfilePictures.liveSeed`): its [seed], only when it has
     * no picture of its own ([imageUri]) nor a [thumbhash] of one, so a
     * real picture is never covered.
     */
    fun liveSeed(seed: String, imageUri: String?, thumbhash: String?): String? =
        seed.takeIf { imageUri == null && thumbhash == null }

    /**
     * FNV-1a over the UTF-8 bytes, then MurmurHash3's finaliser, in 32-bit
     * unsigned arithmetic (an Int's bits here): FNV's low bits barely move
     * for IDs that differ only in their last character, and the pick is
     * taken from the low bits.
     */
    fun hash(seed: String): Int {
        var hash = 0x811C9DC5.toInt()
        for (byte in seed.encodeToByteArray()) {
            hash = hash xor (byte.toInt() and 0xFF)
            hash *= 0x01000193
        }
        hash = (hash xor (hash ushr 16)) * 0x85EBCA6B.toInt()
        hash = (hash xor (hash ushr 13)) * 0xC2B2AE35.toInt()
        return hash xor (hash ushr 16)
    }
}
