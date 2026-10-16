package com.slopus.happy.text

import android.content.res.Resources
import androidx.annotation.PluralsRes
import androidx.compose.runtime.Composable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.ui.platform.LocalResources

/**
 * happy-app's words for [count] from a generated `<plurals>`: the number's
 * own string where a catalog spells it out (`count === 1` in Japanese, which
 * Android files under `other`), else the plural for the locale's category.
 * [args] are the format arguments in the catalog function's parameter order,
 * including [count] itself (`plural(R.plurals.time_minutes_ago, n, n)`).
 */
fun Resources.plural(@PluralsRes id: Int, count: Int, vararg args: Any): String {
    val exact = pluralExactNumbers[id]?.get(count)
    return if (exact != null) getString(exact, *args) else getQuantityString(id, count, *args)
}

/** [Resources.plural] in composition, recomposed on a configuration change. */
@Composable
@ReadOnlyComposable
fun pluralResource(@PluralsRes id: Int, count: Int, vararg args: Any): String {
    return LocalResources.current.plural(id, count, *args)
}
