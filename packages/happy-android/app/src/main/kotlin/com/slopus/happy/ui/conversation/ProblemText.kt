package com.slopus.happy.ui.conversation

import android.content.res.Resources
import androidx.compose.runtime.Composable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.ui.platform.LocalResources
import com.slopus.happy.R
import com.slopus.happy.conversation.FailureReason
import com.slopus.happy.conversation.Problem

/** [problem] in the person's language; the agent's own words as it wrote them. */
fun Resources.problemText(problem: Problem): String = when (problem) {
    is Problem.Said -> problem.text
    is Problem.Link -> getString(problem.reason.text)
    is Problem.Refused -> getString(R.string.conversation_problem_refused, problem.status)
    Problem.PicturesUnreadable -> getString(R.string.conversation_problem_pictures)
    Problem.Unavailable -> getString(R.string.conversation_unavailable)
    is Problem.CommandGone -> getString(R.string.conversation_command_gone, problem.name)
    is Problem.CommandBusy -> getString(R.string.conversation_command_busy, problem.name)
    Problem.Forbidden -> getString(R.string.problem_forbidden)
    Problem.Unknown -> getString(R.string.conversation_problem_unknown)
}

/** An intent's refusal ([com.slopus.happy.agent.IntentRefusal.reason]) as the person reads it. */
fun Resources.refusalText(reason: String): String =
    if (reason == com.slopus.happy.agent.IntentRefusal.FORBIDDEN) getString(R.string.problem_forbidden) else reason

/** [reason] as desktop's failure card words it, in the person's language. */
fun Resources.failureText(reason: FailureReason): String = when (reason) {
    is FailureReason.SignInMissing -> getString(R.string.conversation_failure_signin_missing, reason.product, reason.command)
    is FailureReason.CannotAuthenticate -> getString(R.string.conversation_failure_cannot_authenticate, reason.provider)
    is FailureReason.UsageLimit -> getString(R.string.conversation_failure_usage_limit, reason.vendor)
    is FailureReason.NoAccountAvailable -> getString(R.string.conversation_failure_no_account, reason.pool)
    is FailureReason.RateLimited -> getString(R.string.conversation_failure_rate_limited, reason.vendor)
    is FailureReason.ProviderUnavailable -> getString(R.string.conversation_failure_provider_unavailable, reason.vendor)
    is FailureReason.Network -> getString(R.string.conversation_failure_network, reason.vendor)
    is FailureReason.ContextTooLong -> getString(R.string.conversation_failure_context_too_long, reason.model)
    is FailureReason.ProviderDisabled -> getString(R.string.conversation_failure_provider_disabled, reason.provider)
    is FailureReason.Internal -> getString(R.string.conversation_failure_internal, reason.detail)
    is FailureReason.Said -> reason.text
    FailureReason.Unknown -> getString(R.string.conversation_problem_unknown)
}

@Composable
@ReadOnlyComposable
fun problemText(problem: Problem): String = LocalResources.current.problemText(problem)

@Composable
@ReadOnlyComposable
fun failureText(reason: FailureReason): String = LocalResources.current.failureText(reason)
