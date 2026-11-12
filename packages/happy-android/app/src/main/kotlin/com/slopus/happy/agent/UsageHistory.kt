package com.slopus.happy.agent

import androidx.compose.runtime.Immutable
import com.slopus.happy.chat.arr
import com.slopus.happy.chat.num
import com.slopus.happy.chat.obj
import com.slopus.happy.chat.str
import com.slopus.happy.conversation.AccountUsage
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeParseException

/** What one model spent in a window or a day (`{input, output, cacheRead, cacheWrite}`). */
@Immutable
data class TokenCounts(val input: Long = 0, val output: Long = 0, val cacheRead: Long = 0, val cacheWrite: Long = 0) {
    /** What the activity grid counts: cache reads would flatten every other day. */
    val counted: Long get() = input + output + cacheWrite

    /** Everything, cache reads too, as a model's line counts it (desktop's `tokensTotal`). */
    val total: Long get() = counted + cacheRead

    companion object {
        fun parse(value: JsonElement?): TokenCounts? {
            val counts = value.obj ?: return null
            fun count(key: String) = counts[key].num?.takeIf { it.isFinite() && it > 0 }?.toLong() ?: 0L
            return TokenCounts(count("input"), count("output"), count("cacheRead"), count("cacheWrite"))
        }
    }
}

/**
 * `GET /v0/usage/daily`: the local days that spent tokens, oldest first,
 * each account's models and what they used. Sparse: a day from [since] to
 * today that isn't listed spent nothing, and nothing is known before [since].
 */
@Immutable
data class DailyUsage(val since: LocalDate, val days: List<Day>) {
    @Immutable
    data class Day(val date: LocalDate, val byProvider: Map<String, Map<String, TokenCounts>>)

    /**
     * Every day from [from] to [today], the unlisted ones as nothing, each with
     * its models most first: [providerId]'s alone, or every account's.
     */
    fun activity(from: LocalDate, today: LocalDate, providerId: String? = null): List<ActivityDay> {
        val listed = days.associateBy { it.date }
        val result = ArrayList<ActivityDay>()
        var date = maxOf(from, since)
        while (!date.isAfter(today)) {
            val models = LinkedHashMap<String, Long>()
            for ((id, byModel) in listed[date]?.byProvider.orEmpty()) {
                if (providerId != null && id != providerId) continue
                for ((model, counts) in byModel) models[model] = (models[model] ?: 0L) + counts.counted
            }
            val ranked = models.filter { it.value > 0 }.toList().sortedByDescending { it.second }
            result += ActivityDay(date, ranked.sumOf { it.second }, ranked)
            date = date.plusDays(1)
        }
        return result
    }

    /** Each account's [TokenCounts.counted] over every day listed. */
    fun accountTokens(): Map<String, Long> {
        val tokens = HashMap<String, Long>()
        for (day in days) for ((id, models) in day.byProvider) tokens[id] = (tokens[id] ?: 0L) + models.values.sumOf { it.counted }
        return tokens
    }

    companion object {
        /** How many days back the grid asks for: a year and the week it starts in (desktop's). */
        const val DAYS = 371

        /** The year grid's days back from today, and an account's strip. */
        const val YEAR_DAYS = 364L
        const val STRIP_DAYS = 30L

        /** `{ since, days: [{ date, byProvider: { providerId: { modelId: counts } } }] }`; no `since` is no history at all. */
        fun parse(answer: JsonObject): DailyUsage? {
            val since = date(answer["since"].str) ?: return null
            val days = answer["days"].arr.orEmpty().mapNotNull { item ->
                val day = item.obj ?: return@mapNotNull null
                val date = date(day["date"].str)?.takeIf { !it.isBefore(since) } ?: return@mapNotNull null
                val byProvider = day["byProvider"].obj?.mapNotNull { (id, byModel) ->
                    val models = byModel.obj?.mapNotNull { (model, counts) -> TokenCounts.parse(counts)?.let { model to it } }?.toMap().orEmpty()
                    models.takeIf { it.isNotEmpty() }?.let { id to it }
                }?.toMap() ?: return@mapNotNull null
                Day(date, byProvider)
            }.sortedBy { it.date }
            return DailyUsage(since, days)
        }

        private fun date(text: String?): LocalDate? = try {
            text?.takeIf { it.length == 10 }?.let(LocalDate::parse)
        } catch (_: DateTimeParseException) {
            null
        }
    }
}

/** One day on the grid: its tokens and the models that spent them, most first. */
@Immutable
data class ActivityDay(val date: LocalDate, val tokens: Long, val models: List<Pair<String, Long>>)

/**
 * Five levels: none, then the quartiles of the days that used anything, so
 * one enormous day doesn't wash every other out to the palest (desktop's
 * `levelsOf`).
 */
fun activityLevels(days: List<ActivityDay>): (Long) -> Int {
    val used = days.map { it.tokens }.filter { it > 0 }.sorted()
    if (used.isEmpty()) return { 0 }
    fun at(share: Double) = used[minOf(used.size - 1, (share * used.size).toInt())]
    val cuts = longArrayOf(at(0.25), at(0.5), at(0.75))
    return { tokens ->
        when {
            tokens <= 0 -> 0
            tokens <= cuts[0] -> 1
            tokens <= cuts[1] -> 2
            tokens <= cuts[2] -> 3
            else -> 4
        }
    }
}

/**
 * Where Settings › Usage's grid comes from: null for anything that can't be
 * shown, a failure included, which shows no grid and says nothing.
 */
fun interface DailyUsageSource {
    suspend fun read(days: Int, zone: ZoneId): DailyUsage?
}

/** The connection's own `GET /v0/usage/daily`; a server without it answers 404 once, and isn't asked again. */
class LiveDailyUsageSource(private val client: AgentClient) : DailyUsageSource {
    @Volatile private var unsupported = false

    override suspend fun read(days: Int, zone: ZoneId): DailyUsage? {
        if (unsupported) return null
        return try {
            DailyUsage.parse(client.decode<JsonObject>("GET", "/v0/usage/daily?days=$days&tz=${AgentClient.escape(zone.id)}"))
        } catch (e: CancellationException) {
            throw e
        } catch (e: AgentApiException) {
            if (e.status == 404) unsupported = true
            null
        } catch (_: Exception) {
            null
        }
    }
}

/** One model's tokens in `GET /v0/usage`'s rolling windows. */
@Immutable
data class ModelTokens(
    val modelId: String,
    val hour: TokenCounts? = null,
    val day: TokenCounts? = null,
    val week: TokenCounts? = null,
    val month: TokenCounts? = null,
) {
    /** It spent anything, in any window. */
    val used: Boolean get() = listOfNotNull(hour, day, week, month).any { it.total > 0 }
}

/**
 * One provider account in `GET /v0/usage`: its kind, plan, the week and
 * session windows ([limits], null with neither) and its models' tokens,
 * heaviest month first. Failures and sign-in state are dropped: Usage
 * shows what there is and says nothing of what isn't.
 */
@Immutable
data class UsageAccount(
    val providerId: String,
    val type: String? = null,
    val name: String? = null,
    val planName: String? = null,
    val limits: AccountUsage? = null,
    val models: List<ModelTokens> = emptyList(),
) {
    companion object {
        fun parse(response: JsonObject): List<UsageAccount> {
            val limits = AccountUsage.project(response)
            fun window(key: String) = response[key].obj
            val windows = listOf("hour", "day", "week", "month").map(::window)
            return response["providers"].arr.orEmpty().mapNotNull { item ->
                val entry = item.obj ?: return@mapNotNull null
                val id = entry["providerId"].str ?: return@mapNotNull null
                val models = windows.flatMap { it?.get(id).obj?.keys.orEmpty() }.distinct().map { model ->
                    fun counts(at: Int) = TokenCounts.parse(windows[at]?.get(id).obj?.get(model))
                    ModelTokens(model, counts(0), counts(1), counts(2), counts(3))
                }.filter { it.used }.sortedWith(compareByDescending<ModelTokens> { it.month?.total ?: 0L }.thenBy { it.modelId })
                UsageAccount(
                    providerId = id,
                    type = entry["type"].str ?: entry["usage"].obj?.get("vendor").str,
                    name = entry["name"].str?.takeIf { it.isNotBlank() },
                    planName = entry["usage"].obj?.get("planName").str?.takeIf { it.isNotBlank() },
                    limits = limits[id]
                        ?.takeIf { it.week != null || it.session != null }
                        ?.copy(refreshError = null, signedOut = false, limited = false, limitResets = null),
                    models = models,
                )
            }
        }
    }
}
