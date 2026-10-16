package com.slopus.happy.ui.chat

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import com.slopus.happy.R
import com.slopus.happy.chat.ChatMessage
import com.slopus.happy.chat.ToolState
import com.slopus.happy.chat.tools.taskChildTools
import com.slopus.happy.chat.tools.todoItems
import com.slopus.happy.text.pluralResource
import com.slopus.happy.ui.components.Icon
import com.slopus.happy.ui.components.Ionicon
import com.slopus.happy.ui.theme.HappyTheme

/**
 * TodoView.tsx: 4 apart, each 2 above and below, 14 text "☐ item" in #666
 * when pending, #007AFF in progress, "☑ item" #34C759 struck through when
 * done. Nothing without todos.
 */
@Composable
internal fun TodoView(message: ChatMessage.ToolCallMessage) {
    val todos = remember(message.tool) { todoItems(message) }
    if (todos.isEmpty()) return
    ToolSection {
        Column(verticalArrangement = Arrangement.spacedBy(ToolSpec.todoGap)) {
            for (todo in todos) {
                val completed = todo.status == "completed"
                Text(
                    text = "${if (completed) "☑" else "☐"} ${todo.content}",
                    style = ToolSpec.todoText.copy(textDecoration = if (completed) TextDecoration.LineThrough else null),
                    color = when (todo.status) {
                        "completed" -> ToolSpec.todoCompleted
                        "in_progress" -> ToolSpec.todoInProgress
                        "pending" -> ToolSpec.todoPending
                        else -> Color.Black
                    },
                    modifier = Modifier.fillMaxWidth().testTag(ToolTags.TODO).padding(vertical = ToolSpec.todoPaddingVertical),
                )
            }
        }
    }
}

/**
 * TaskView.tsx: the sub-agent's last three started tools (4 above, 12
 * below): each row 4 above and below, 4 in on the left and 2 on the right,
 * its activity label in mono 14 weight 500 textSecondary, then 8 apart a
 * 14 spinner in the warning colour, a 16 checkmark-circle in the success
 * colour, or a 16 close-circle in textDestructive; then "+N more tools"
 * (14 italic textSecondary at 0.7, padding 4). Nothing before the first.
 */
@Composable
internal fun TaskView(message: ChatMessage.ToolCallMessage) {
    val text = rememberToolText()
    val tools = remember(message, text) { taskChildTools(message, text) }
    if (tools.isEmpty()) return
    val colors = HappyTheme.colors
    val remaining = maxOf(0, tools.size - ToolSpec.TASK_VISIBLE)
    Column(modifier = Modifier.fillMaxWidth().padding(top = ToolSpec.taskPaddingTop, bottom = ToolSpec.taskPaddingBottom)) {
        for ((label, state) in tools.takeLast(ToolSpec.TASK_VISIBLE)) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .testTag(ToolTags.TASK_ITEM)
                    .padding(top = ToolSpec.taskItemPaddingVertical, bottom = ToolSpec.taskItemPaddingVertical, start = ToolSpec.taskItemPaddingStart, end = ToolSpec.taskItemPaddingEnd),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(label, style = ToolSpec.taskTitle, color = colors.textSecondary, modifier = Modifier.weight(1f))
                Box(modifier = Modifier.padding(start = ToolSpec.taskStatusPaddingStart)) {
                    when (state) {
                        ToolState.Running -> CircularProgressIndicator(Modifier.size(ToolSpec.taskSpinner), color = colors.warning, strokeWidth = 2.dp)
                        ToolState.Completed -> Icon(Ionicon.CheckmarkCircle, ToolSpec.taskStatusIcon, colors.success)
                        ToolState.Error -> Icon(Ionicon.CloseCircle, ToolSpec.taskStatusIcon, colors.textDestructive)
                    }
                }
            }
        }
        if (remaining > 0) {
            Text(
                pluralResource(R.plurals.tools_task_view_more_tools, remaining, remaining),
                style = ToolSpec.taskMore,
                color = colors.textSecondary,
                modifier = Modifier
                    .testTag(ToolTags.TASK_MORE)
                    .alpha(ToolSpec.TASK_MORE_OPACITY)
                    .padding(ToolSpec.taskItemPaddingStart),
            )
        }
    }
}
