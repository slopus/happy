package com.slopus.happy.ui.onboarding

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import com.slopus.happy.R
import com.slopus.happy.ui.components.RoundButton

/**
 * Signed out, on a phone (index.tsx NotAuthenticated): create an account,
 * or the quiet "restore existing account" under it.
 */
@Composable
fun WelcomeScreen(
    customServerLabel: String?,
    creatingAccount: Boolean,
    onCreateAccount: () -> Unit,
    onRestore: () -> Unit,
    onServer: () -> Unit,
    modifier: Modifier = Modifier,
) {
    OnboardingScreen(
        modifier = modifier,
        header = { OnboardingHeader(customServerLabel = customServerLabel, onServer = onServer) },
        content = { WelcomeContent() },
        primary = {
            RoundButton(
                title = stringResource(R.string.onboarding_create_account),
                onClick = onCreateAccount,
                loading = creatingAccount,
            )
        },
        secondary = SecondaryAction(
            title = stringResource(R.string.onboarding_restore_existing),
            onClick = onRestore,
        ),
    )
}
