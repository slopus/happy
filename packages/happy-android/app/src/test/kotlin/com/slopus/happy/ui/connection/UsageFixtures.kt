package com.slopus.happy.ui.connection

import com.slopus.happy.agent.DailyUsage
import com.slopus.happy.agent.DailyUsageSource
import com.slopus.happy.agent.UsageAccount
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import java.time.DayOfWeek
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneId
import kotlin.random.Random
import androidx.compose.ui.test.click
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.unit.dp

/**
 * A computer's usage as Settings › Usage reads it, for tests and shots: two
 * Claude accounts, Codex and Bedrock spending through the year, and a Grok
 * account that is signed out with nothing to show, which the page leaves out.
 * Wednesday, Nov 11 2026, 2:30 PM; the history starts Jun 2 2025, more than a year back.
 */
object UsageFixtures {
    val today: LocalDate = LocalDate.of(2026, 11, 11)
    val zone: ZoneId = ZoneId.systemDefault()
    val now: Long = LocalDateTime.of(2026, 11, 11, 14, 30).atZone(zone).toInstant().toEpochMilli()
    val since: LocalDate = LocalDate.of(2025, 6, 2)

    /** A Sunday on which nothing was spent. */
    val quietDay: LocalDate = LocalDate.of(2026, 11, 8)

    private fun at(date: LocalDate, hour: Int, minute: Int) = LocalDateTime.of(date, java.time.LocalTime.of(hour, minute)).atZone(zone).toInstant().toEpochMilli()

    val names = mapOf("claude-max" to "Claude Max", "claude-team" to "Acme Team", "codex" to "ChatGPT Pro", "bedrock" to "AWS Bedrock")

    /** Each account's models and its share of a day. */
    private val spend = listOf(
        Triple("claude-max", listOf("claude-opus-4-1" to 0.7, "claude-sonnet-4-5" to 0.3), 1.0),
        Triple("codex", listOf("gpt-5-codex" to 0.85, "gpt-5" to 0.15), 0.45),
        Triple("claude-team", listOf("claude-sonnet-4-5" to 1.0), 0.18),
        Triple("bedrock", listOf("anthropic.claude-sonnet-4" to 1.0), 0.05),
    )

    /** A day's tokens for each account: quieter at weekends, busier over the year, a week off in August. */
    private fun dayTokens(date: LocalDate, random: Random): Map<String, Map<String, Long>> {
        if (date == quietDay || (date.monthValue == 8 && date.dayOfMonth in 10..16)) return emptyMap()
        val weekend = date.dayOfWeek == DayOfWeek.SATURDAY || date.dayOfWeek == DayOfWeek.SUNDAY
        if (random.nextDouble() < (if (weekend) 0.55 else 0.06)) return emptyMap()
        val growth = 0.35 + 0.65 * (date.toEpochDay() - since.toEpochDay()) / (today.toEpochDay() - since.toEpochDay()).toDouble()
        val base = 9_000_000.0 * growth * (if (weekend) 0.3 else 1.0) * (0.25 + random.nextDouble() * 1.2)
        return spend.mapNotNull { (account, models, share) ->
            if (account != "claude-max" && random.nextDouble() < 0.35) return@mapNotNull null
            account to models.associate { (model, part) -> model to (base * share * part).toLong() }
        }.toMap()
    }

    private val days: Map<LocalDate, Map<String, Map<String, Long>>> by lazy {
        val random = Random(7)
        generateSequence(since) { it.plusDays(1) }.takeWhile { !it.isAfter(today) }.associateWith { dayTokens(it, random) }
    }

    /** One count as the server splits it: input, output, cache writes and the cache reads the grid leaves out. */
    private fun kotlinx.serialization.json.JsonObjectBuilder.counts(key: String, tokens: Long) = putJsonObject(key) {
        put("input", tokens * 55 / 100)
        put("output", tokens * 15 / 100)
        put("cacheWrite", tokens * 30 / 100)
        put("cacheRead", tokens * 4)
    }

    /** `GET /v0/usage/daily?days=371`: the days that spent, sparse. */
    fun daily(): JsonObject = buildJsonObject {
        put("since", since.toString())
        putJsonArray("days") {
            for ((date, accounts) in days) {
                if (accounts.isEmpty()) continue
                addJsonObject {
                    put("date", date.toString())
                    putJsonObject("byProvider") {
                        for ((account, models) in accounts) putJsonObject(account) { for ((model, tokens) in models) counts(model, tokens) }
                    }
                }
            }
        }
    }

    /** `GET /v0/usage`: the accounts, their windows, and the rolling windows' tokens. */
    fun usage(): JsonObject = buildJsonObject {
        putJsonArray("providers") {
            addJsonObject {
                put("providerId", "claude-max")
                put("type", "claude")
                put("refreshedAt", now - 4 * 60_000)
                putJsonObject("usage") {
                    put("vendor", "claude")
                    put("planName", "Max 20x")
                    put("capturedAt", now - 4 * 60_000)
                    putJsonObject("windows") {
                        putJsonObject("weekly") { put("usedPercent", 73); put("resetsAt", at(LocalDate.of(2026, 11, 14), 4, 0)) }
                        putJsonObject("fiveHour") { put("usedPercent", 41); put("resetsAt", at(today, 17, 10)) }
                    }
                }
            }
            addJsonObject {
                put("providerId", "claude-team")
                put("type", "claude")
                put("refreshedAt", now - 12 * 60_000)
                putJsonObject("usage") {
                    put("vendor", "claude")
                    put("planName", "Team")
                    put("capturedAt", now - 12 * 60_000)
                    putJsonObject("windows") {
                        putJsonObject("weekly") { put("usedPercent", 12); put("resetsAt", at(LocalDate.of(2026, 11, 16), 9, 0)) }
                        putJsonObject("fiveHour") { put("usedPercent", 88); put("resetsAt", at(today, 15, 45)) }
                    }
                }
            }
            addJsonObject {
                put("providerId", "codex")
                put("type", "codex")
                put("refreshedAt", now - 60_000)
                putJsonObject("usage") {
                    put("vendor", "codex")
                    put("planName", "Pro")
                    put("capturedAt", now - 60_000)
                    putJsonObject("windows") {
                        putJsonObject("weekly") { put("usedPercent", 22); put("resetsAt", at(LocalDate.of(2026, 11, 17), 2, 30)) }
                        putJsonObject("fiveHour") { put("usedPercent", 5); put("resetsAt", at(today, 18, 0)) }
                    }
                }
            }
            // No plan to read: only its tokens show.
            addJsonObject {
                put("providerId", "bedrock")
                put("type", "bedrock")
            }
            // Signed out, failing, and nothing spent: left out, and its error never shown.
            addJsonObject {
                put("providerId", "grok")
                put("type", "grok")
                put("signIn", "signed_out")
                put("error", "401 Unauthorized: token expired")
                put("refreshError", "401 Unauthorized: token expired")
            }
        }
        val windows = listOf("hour" to 0L..0L, "day" to 0L..0L, "week" to 6L..0L, "month" to 29L..0L)
        for ((key, back) in windows) {
            putJsonObject(key) {
                for ((account, models, _) in spend) {
                    val totals = HashMap<String, Long>()
                    var date = today.minusDays(back.first)
                    while (!date.isAfter(today)) {
                        for ((model, tokens) in days[date]?.get(account).orEmpty()) totals[model] = (totals[model] ?: 0L) + tokens
                        date = date.plusDays(1)
                    }
                    // The hour is a slice of today.
                    if (key == "hour") totals.replaceAll { _, tokens -> tokens / 9 }
                    if (totals.values.all { it == 0L }) continue
                    putJsonObject(account) { for (model in models.map { it.first }) totals[model]?.takeIf { it > 0 }?.let { counts(model, it) } }
                }
            }
        }
    }

    val history: DailyUsage get() = DailyUsage.parse(daily())!!
    val accounts: List<UsageAccount> get() = UsageAccount.parse(usage())
    val ready: AgentUsageState.Ready get() = AgentUsageState.Ready(accounts, history, names)

    /** The daily route as a source: the fixture, or nothing for a server without it. */
    fun source(answer: JsonObject? = daily()) = DailyUsageSource { _, _ -> answer?.let(DailyUsage::parse) }

    /**
     * Taps [date] on the year grid. The grid opens on today and may run past
     * the page's edge; a touch is placed in what shows, so it is measured from
     * the grid's right edge, where today's week is.
     */
    fun tapDay(rule: androidx.compose.ui.test.junit4.ComposeTestRule, date: LocalDate) {
        val days = history.activity(today.minusDays(DailyUsage.YEAR_DAYS), today)
        val offset = days.first().date.dayOfWeek.value - 1
        val index = days.indexOfFirst { it.date == date } + offset
        val last = days.lastIndex + offset
        rule.onNode(androidx.compose.ui.test.hasContentDescription("Tokens used each day")).performTouchInput {
            val fromEnd = (last / 7 - index / 7) * 12 + 5
            click(androidx.compose.ui.geometry.Offset(visibleSize.width - fromEnd.dp.toPx(), ((index % 7) * 12 + 5).dp.toPx()))
        }
        rule.waitForIdle()
    }
}
