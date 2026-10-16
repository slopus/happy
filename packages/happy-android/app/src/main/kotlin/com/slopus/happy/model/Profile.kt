package com.slopus.happy.model

import androidx.compose.runtime.Immutable
import kotlinx.serialization.json.JsonObject

@Immutable
data class GitHubProfile(val id: Double, val login: String, val name: String, val avatarUrl: String, val email: String?, val bio: String?)

@Immutable
data class ImageRef(val width: Double, val height: Double, val thumbhash: String, val path: String, val url: String)

/** happy-app sync/profile.ts `ProfileSchema`. */
@Immutable
data class Profile(
    val id: String,
    val timestamp: Long,
    val firstName: String?,
    val lastName: String?,
    val avatar: ImageRef?,
    val github: GitHubProfile?,
    val connectedServices: List<String>,
) {
    /** getDisplayName */
    val displayName: String?
        get() {
            if (!firstName.isNullOrEmpty() || !lastName.isNullOrEmpty()) {
                return listOf(firstName, lastName).filter { !it.isNullOrEmpty() }.joinToString(" ")
            }
            github?.name?.takeIf { it.isNotEmpty() }?.let { return it }
            github?.login?.takeIf { it.isNotEmpty() }?.let { return it }
            return null
        }

    /** getAvatarUrl */
    val avatarUrl: String?
        get() = avatar?.url?.takeIf { it.isNotEmpty() } ?: github?.avatarUrl?.takeIf { it.isNotEmpty() }

    /** getBio */
    val bio: String? get() = github?.bio?.takeIf { it.isNotEmpty() }

    companion object {
        val Defaults = Profile("", 0, null, null, null, null, emptyList())

        /** profileParse: a profile that does not match the schema reads as the defaults. */
        fun parse(json: JsonObject?): Profile {
            if (json == null) return Defaults
            return try {
                read(JsonFields(json))
            } catch (_: SchemaException) {
                Defaults
            }
        }

        private fun read(f: JsonFields): Profile {
            // `.nullable()`: present, null or a value.
            for (key in listOf("firstName", "lastName", "avatar", "github")) {
                if (!f.raw.containsKey(key)) throw SchemaException("$key: required")
            }
            return Profile(
                id = f.required("id", Read.string),
                timestamp = f.required("timestamp", Read.long),
                firstName = f.nullish("firstName", Read.string),
                lastName = f.nullish("lastName", Read.string),
                avatar = f.nullish(
                    "avatar",
                    Read.objectOf { o ->
                        ImageRef(
                            o.required("width", Read.number),
                            o.required("height", Read.number),
                            o.required("thumbhash", Read.string),
                            o.required("path", Read.string),
                            o.required("url", Read.string),
                        )
                    },
                ),
                github = f.nullish(
                    "github",
                    Read.objectOf { o ->
                        if (!o.raw.containsKey("bio")) throw SchemaException("bio: required")
                        GitHubProfile(
                            id = o.required("id", Read.number),
                            login = o.required("login", Read.string),
                            name = o.required("name", Read.string),
                            avatarUrl = o.required("avatar_url", Read.string),
                            email = o.optional("email", Read.string),
                            bio = o.nullish("bio", Read.string),
                        )
                    },
                ),
                connectedServices = f.optional("connectedServices", Read.arrayOf(Read.string)) ?: emptyList(),
            )
        }
    }
}
