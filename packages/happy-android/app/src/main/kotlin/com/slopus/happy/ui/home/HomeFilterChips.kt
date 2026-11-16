package com.slopus.happy.ui.home

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.model.HomeFilter
import com.slopus.happy.ui.components.HomeCardSpec
import com.slopus.happy.ui.layout.LocalWindowLayout
import com.slopus.happy.ui.layout.contentMaxWidth
import com.slopus.happy.ui.theme.HappyTheme
import com.slopus.happy.ui.theme.happyTextStyle

/**
 * Filter chip labels from string resources.
 */
@Composable
fun homeFilterLabel(filter: HomeFilter): String = when (filter) {
    HomeFilter.All -> stringResource(R.string.home_filter_all)
    HomeFilter.Bots -> stringResource(R.string.home_filter_bots)
    HomeFilter.Tasks -> stringResource(R.string.home_filter_tasks)
    HomeFilter.Projects -> stringResource(R.string.home_filter_projects)
    HomeFilter.Unread -> stringResource(R.string.home_filter_unread)
}

/**
 * Horizontal scrollable row of filter chips at the top of the home screen:
 * - All
 * - Bots
 * - Tasks
 * - Projects
 * - Unread (with optional badge for unread count)
 */
@Composable
fun HomeFilterChips(
    selected: HomeFilter,
    unreadCount: Int,
    onSelect: (HomeFilter) -> Unit,
    carded: Boolean,
    modifier: Modifier = Modifier,
) {
    val colors = HappyTheme.colors
    val layout = LocalWindowLayout.current
    Row(
        modifier = modifier
            .then(if (carded) Modifier.contentMaxWidth(layout) else Modifier.fillMaxWidth())
            .testTag(HomeTags.FILTER_CHIPS)
            .horizontalScroll(rememberScrollState())
            .padding(
                start = HomeCardSpec.inset,
                end = HomeCardSpec.inset,
                top = 2.dp,
                bottom = 10.dp,
            ),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        HomeFilter.entries.forEach { filter ->
            val picked = filter == selected
            val label = homeFilterLabel(filter)
            val showBadge = filter == HomeFilter.Unread && unreadCount > 0
            FilterChip(
                selected = picked,
                onClick = { onSelect(filter) },
                label = {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        Text(
                            text = label,
                            style = happyTextStyle(fontSize = 13, weight = if (picked) FontWeight.SemiBold else FontWeight.Normal),
                        )
                        if (showBadge) {
                            val overflowText = stringResource(R.string.home_filter_badge_overflow)
                            Box(
                                modifier = Modifier
                                    .testTag(HomeTags.FILTER_UNREAD_BADGE)
                                    .background(
                                        color = colors.textLink,
                                        shape = RoundedCornerShape(10.dp),
                                    )
                                    .padding(horizontal = 6.dp, vertical = 1.dp),
                                contentAlignment = Alignment.Center,
                            ) {
                                Text(
                                    text = if (unreadCount > 99) overflowText else unreadCount.toString(),
                                    style = happyTextStyle(fontSize = 11, weight = FontWeight.Bold),
                                    color = Color.White,
                                )
                            }
                        }
                    }
                },
                shape = RoundedCornerShape(16.dp),
                colors = FilterChipDefaults.filterChipColors(
                    containerColor = colors.surfaceHigh,
                    labelColor = colors.textSecondary,
                    selectedContainerColor = if (colors.dark) colors.surfaceHighest else colors.surfaceSelected,
                    selectedLabelColor = colors.text,
                ),
                border = FilterChipDefaults.filterChipBorder(
                    enabled = true,
                    selected = picked,
                    borderColor = colors.divider,
                    selectedBorderColor = if (colors.dark) colors.text.copy(alpha = 0.25f) else colors.text.copy(alpha = 0.18f),
                    borderWidth = 1.dp,
                ),
                modifier = Modifier
                    .minimumInteractiveComponentSize()
                    .testTag(HomeTags.filterChip(filter))
                    .semantics {
                        contentDescription = when (filter) {
                            HomeFilter.Unread -> if (unreadCount > 0) {
                                pluralStringResource(R.plurals.home_filter_unread_desc_with_count, unreadCount, label, unreadCount)
                            } else {
                                label
                            }
                            else -> label
                        }
                    },
            )
        }
    }
}

/**
 * Notice shown when the active filter produces zero results (e.g. no unread chats).
 */
@Composable
fun HomeFilterEmptyNotice(
    filter: HomeFilter,
    modifier: Modifier = Modifier,
) {
    val colors = HappyTheme.colors
    val text = when (filter) {
        HomeFilter.All -> stringResource(R.string.home_filter_empty_all)
        HomeFilter.Bots -> stringResource(R.string.home_filter_empty_bots)
        HomeFilter.Tasks -> stringResource(R.string.home_filter_empty_tasks)
        HomeFilter.Projects -> stringResource(R.string.home_filter_empty_projects)
        HomeFilter.Unread -> stringResource(R.string.home_filter_empty_unread)
    }
    Box(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 24.dp, vertical = 64.dp)
            .testTag(HomeTags.FILTER_EMPTY)
            .semantics { liveRegion = LiveRegionMode.Polite },
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = text,
            style = happyTextStyle(fontSize = 15, weight = FontWeight.Medium),
            color = colors.textSecondary,
        )
    }
}
