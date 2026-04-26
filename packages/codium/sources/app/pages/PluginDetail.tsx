import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Page } from '@/app/components/Page'
import { pluginHost, usePlugin } from '@/plugins'
import './Plugins.css'

const CRED_PROMPT: Record<string, { label: string; placeholder: string; help: string }> = {
    anthropic: {
        label: 'Anthropic API key',
        placeholder: 'sk-ant-…',
        help: 'Create one at console.anthropic.com → Settings → API keys.',
    },
}

/** Plugins whose connect() call doesn't take a credential string — they
 *  drive their own auth flow (e.g. OAuth via Codex CLI). */
const OAUTH_PLUGINS: Record<string, { buttonLabel: string; help: string }> = {
    codex: {
        buttonLabel: 'Sign in with Codex',
        help: 'Opens your browser to auth.openai.com via the Codex CLI. You\'ll need Codex.app or `npm i -g @openai/codex` installed.',
    },
}

export function PluginDetailPage() {
    const { id = '' } = useParams<{ id: string }>()
    const plugin = usePlugin(id)
    const navigate = useNavigate()
    const [credential, setCredential] = useState('')
    const [busy, setBusy] = useState(false)

    if (!plugin) {
        return (
            <Page title="Plugin not found">
                <p className="app__subtitle">No plugin with id "{id}".</p>
                <Link to="/plugins" className="plugins-page__action">Back to plugins</Link>
            </Page>
        )
    }

    const auth = plugin.getAuthState()
    const oauthPrompt = OAUTH_PLUGINS[plugin.id]
    const credPrompt = !oauthPrompt
        ? CRED_PROMPT[plugin.id] ?? { label: 'Credential', placeholder: '', help: 'Plugin-specific credential.' }
        : null

    const onConnect = async () => {
        setBusy(true)
        try {
            // OAuth plugins ignore the credential string; we still pass empty.
            await pluginHost.connect(plugin.id, oauthPrompt ? '' : credential)
        } finally {
            setBusy(false)
            setCredential('')
        }
    }
    const onDisconnect = async () => {
        setBusy(true)
        try {
            await pluginHost.disconnect(plugin.id)
        } finally {
            setBusy(false)
        }
    }

    return (
        <Page
            title={
                <div className="plugins-page__header">
                    <button
                        type="button"
                        onClick={() => navigate('/plugins')}
                        className="plugins-page__action"
                        aria-label="Back to plugins"
                    >
                        ← Plugins
                    </button>
                    <span style={{ marginLeft: 4 }}>{plugin.name}</span>
                </div>
            }
        >
            <div className="plugin-detail">
                <div className="plugin-detail__hero">
                    <div
                        className="plugin-card__avatar plugin-card__avatar--lg"
                        style={{ background: plugin.accent ?? 'var(--color-button-bg)' }}
                        aria-hidden
                    >
                        {plugin.name.slice(0, 1).toUpperCase()}
                    </div>
                    <div>
                        <div className="plugin-detail__name">{plugin.name}</div>
                        <div className="plugin-detail__vendor">by {plugin.vendor}</div>
                        <div className="plugin-detail__description">{plugin.description}</div>
                    </div>
                </div>

                <section className="plugin-detail__section">
                    <h3 className="plugins-section__heading">Authentication</h3>
                    {auth.status === 'connected' ? (
                        <div className="plugin-detail__row">
                            <span className="plugin-card__status plugin-card__status--good">
                                <span className="plugin-card__status-dot" aria-hidden />
                                Connected
                                {auth.account ? ` as ${auth.account}` : ''}
                            </span>
                            <button
                                type="button"
                                className="plugins-page__action"
                                onClick={onDisconnect}
                                disabled={busy}
                            >
                                Disconnect
                            </button>
                        </div>
                    ) : oauthPrompt ? (
                        <div className="plugin-detail__row plugin-detail__row--column">
                            <small className="plugin-detail__help">{oauthPrompt.help}</small>
                            {auth.status === 'error' && (
                                <small className="plugin-detail__help plugin-detail__help--bad">
                                    {auth.message}
                                </small>
                            )}
                            <div className="plugin-detail__actions">
                                <button
                                    type="button"
                                    className="plugins-page__action plugins-page__action--primary"
                                    onClick={onConnect}
                                    disabled={busy || auth.status === 'connecting'}
                                >
                                    {busy || auth.status === 'connecting' ? 'Waiting for browser…' : oauthPrompt.buttonLabel}
                                </button>
                            </div>
                        </div>
                    ) : credPrompt ? (
                        <div className="plugin-detail__row plugin-detail__row--column">
                            <label className="plugin-detail__label">{credPrompt.label}</label>
                            <input
                                type="password"
                                className="plugin-detail__input"
                                placeholder={credPrompt.placeholder}
                                value={credential}
                                onChange={(e) => setCredential(e.target.value)}
                                autoComplete="off"
                                spellCheck={false}
                            />
                            <small className="plugin-detail__help">{credPrompt.help}</small>
                            {auth.status === 'error' && (
                                <small className="plugin-detail__help plugin-detail__help--bad">
                                    {auth.message}
                                </small>
                            )}
                            <div className="plugin-detail__actions">
                                <button
                                    type="button"
                                    className="plugins-page__action plugins-page__action--primary"
                                    onClick={onConnect}
                                    disabled={busy || credential.trim().length === 0}
                                >
                                    {busy || auth.status === 'connecting' ? 'Connecting…' : 'Connect'}
                                </button>
                            </div>
                        </div>
                    ) : null}
                </section>

                {plugin.getCapabilities().some((c) => c.type === 'llm-inference') && (
                    <section className="plugin-detail__section">
                        <h3 className="plugins-section__heading">Models</h3>
                        <ul className="plugin-detail__models">
                            {plugin.getCapabilities()
                                .flatMap((c) => (c.type === 'llm-inference' ? c.models : []))
                                .map((m) => (
                                    <li key={m.id} className="plugin-detail__model">
                                        <span className="plugin-detail__model-label">{m.label}</span>
                                        {m.description && (
                                            <span className="plugin-detail__model-description">
                                                {m.description}
                                            </span>
                                        )}
                                    </li>
                                ))}
                        </ul>
                    </section>
                )}
            </div>
        </Page>
    )
}
