package com.slopus.happy.ui

import android.annotation.SuppressLint
import androidx.navigation.NavBackStackEntry
import androidx.navigation.NavController
import kotlinx.coroutines.flow.StateFlow

/**
 * The complete stack, including stopped entries retained behind the current
 * screen. Navigation exposes only visibleEntries publicly; that omits the
 * covered pages our retained host, account stacks and tablet roots must keep.
 * Keep the dependency on its library-group API at this one boundary, checked
 * by the retained-page and tablet navigation tests when Navigation is upgraded.
 */
internal val NavController.backStackEntries: StateFlow<List<NavBackStackEntry>>
    @SuppressLint("RestrictedApi")
    get() = currentBackStack