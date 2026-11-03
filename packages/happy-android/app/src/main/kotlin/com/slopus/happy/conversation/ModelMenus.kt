package com.slopus.happy.conversation

import androidx.compose.runtime.Immutable

/**
 * Desktop's `happyAgentComposerModelControlProps` as iOS flattens it for a
 * phone (`ModelMenus`, e2238fdc4 and 083c30df4): the services (one per
 * provider type) with their accounts in the catalog's order, the models
 * each lists, and what is selected. The model chip lists the services'
 * models, a service's heading opens its accounts, and the effort chip lists
 * the selected model's efforts.
 */
@Immutable
data class ModelMenus(
    val services: List<Service>,
    val selection: Mode,
    /** The selected model, listed or not. */
    val current: ModelChoice?,
    val notice: Notice?,
) {
    @Immutable
    data class Account(val id: String, val label: String, val models: List<Choice>)

    /** A model on an account; [disabled] when its account is switched off or offers nothing. */
    @Immutable
    data class Choice(val model: ModelChoice, val disabled: Boolean) {
        val id: String get() = model.modelId
    }

    @Immutable
    data class Service(
        val id: String,
        val label: String,
        val accounts: List<Account>,
        /** The account whose models the service lists: the selected one when it is this service's, else the first that is on. */
        val account: String,
    ) {
        val shown: Account? get() = accounts.firstOrNull { it.id == account } ?: accounts.firstOrNull()
    }

    /** Why the selected account is named although it is not a choice. */
    sealed interface Notice {
        /** It still works; it is only kept out of the lists. */
        data object Hidden : Notice
        /** It is no longer configured on the computer. */
        data class Removed(val name: String) : Notice
        /** It is switched off, so nothing is sent to it. */
        data class Off(val name: String) : Notice
    }

    /** The selected service, and its account. */
    val selectedService: Service? get() = services.firstOrNull { service -> service.accounts.any { it.id == selection.providerId } }
    val selectedAccount: Account? get() = selectedService?.accounts?.firstOrNull { it.id == selection.providerId }

    /** The effort shown: the selection's when its model runs it, else the model's own default. */
    val effort: String?
        get() {
            val current = current ?: return selection.effort
            return if (selection.effort in current.efforts) selection.effort else current.defaultEffort ?: selection.effort
        }

    /** Nothing to list and no model to name: "Models not configured". */
    val isEmpty: Boolean get() = services.isEmpty() && current == null

    /** The selection's model is in one of the lists. */
    val listsSelection: Boolean
        get() = services.any { service -> service.shown?.id == selection.providerId && service.shown?.models?.any { it.id == selection.modelId } == true }

    /** `composerModelAccountModel`: the model an account is switched onto, the same one when it offers it, else its first. */
    fun model(on: Account): Choice? =
        on.models.firstOrNull { it.id == selection.modelId && !it.disabled } ?: on.models.firstOrNull { !it.disabled }

    /** `composerModelListedAccounts`: every account the lists name, and the selected one. */
    val listedAccounts: List<String>
        get() = services.flatMap { s -> s.accounts.map { it.id } }.let { if (selection.providerId in it) it else it + selection.providerId }

    companion object {
        fun of(catalog: ModeCatalog, selection: Mode): ModelMenus {
            val services = ArrayList<Service>()
            var current: ModelChoice? = null
            for (provider in catalog.providers) {
                val choices = provider.models.map { Choice(it, disabled = provider.isDisabled) }
                if (provider.id == selection.providerId) current = choices.firstOrNull { it.id == selection.modelId }?.model
                // A hidden account or model is not offered, though the selection on it stays, and a hidden
                // model the conversation is already on stays in its own list (`happyAgentMenusDerive`). An
                // account with nothing to list is no row at all.
                if (provider.hidden) continue
                val offered = choices.filter { (provider.id == selection.providerId && it.id == selection.modelId) || it.id !in provider.hiddenModels }
                if (offered.isEmpty()) continue
                val account = Account(provider.id, provider.name ?: provider.id, offered)
                val index = services.indexOfFirst { it.id == provider.type }
                if (index >= 0) {
                    val service = services[index]
                    services[index] = service.copy(
                        accounts = service.accounts + account,
                        account = if (provider.id == selection.providerId) provider.id else service.account,
                    )
                } else {
                    services += Service(provider.type, ModeCatalog.providerName(provider.type), listOf(account), provider.id)
                }
                // A switched-off account is listed, but a service opens on one that works.
                val at = services.indexOfFirst { it.id == provider.type }
                val service = services[at]
                if (!provider.isDisabled && catalog.provider(service.account)?.isDisabled == true && service.accounts.none { it.id == selection.providerId }) {
                    services[at] = service.copy(account = provider.id)
                }
            }
            // An account removed from the configuration still names its model.
            if (current == null) current = catalog.defined[selection.modelId]?.copy(providerId = selection.providerId)
            val selected = catalog.provider(selection.providerId)
            // `currentAccount`: gone, switched off, hidden, or an ordinary choice. On but offering nothing says nothing.
            val name = selected?.name ?: selection.providerId
            val notice = when {
                selected == null -> Notice.Removed(name)
                !selected.enabled -> Notice.Off(name)
                selected.hidden -> Notice.Hidden
                else -> null
            }
            return ModelMenus(services, selection, current, notice)
        }
    }
}
