import { Link } from 'react-router-dom'
import { Page } from '@/app/components/Page'
import { usePlugins } from '@/plugins'
import type { AuthState, Plugin, PluginCategory } from '@/plugins'
import './Plugins.css'

const SECTION_LABELS: Record<PluginCategory, string> = {
    inference: 'Inference providers',
    tools: 'Tools',
    integrations: 'Integrations',
}

function statusLabel(state: AuthState): { text: string; tone: 'idle' | 'good' | 'bad' | 'busy' } {
    switch (state.status) {
        case 'connected':    return { text: 'Connected',     tone: 'good' }
        case 'connecting':   return { text: 'Connecting…',   tone: 'busy' }
        case 'error':        return { text: state.message,   tone: 'bad'  }
        case 'unconfigured': return { text: 'Not connected', tone: 'idle' }
    }
}

function PluginCard({ plugin }: { plugin: Plugin }) {
    const status = statusLabel(plugin.getAuthState())
    const initial = plugin.name.slice(0, 1).toUpperCase()
    return (
        <Link to={`/plugins/${plugin.id}`} className="plugin-card">
            <div
                className="plugin-card__avatar"
                style={{ background: plugin.accent ?? 'var(--color-button-bg)' }}
                aria-hidden
            >
                {initial}
            </div>
            <div className="plugin-card__body">
                <div className="plugin-card__title-row">
                    <span className="plugin-card__name">{plugin.name}</span>
                    <span className="plugin-card__vendor">{plugin.vendor}</span>
                </div>
                <div className="plugin-card__description">{plugin.description}</div>
            </div>
            <span className={`plugin-card__status plugin-card__status--${status.tone}`}>
                <span className="plugin-card__status-dot" aria-hidden />
                {status.text}
            </span>
        </Link>
    )
}

export function PluginsPage() {
    const plugins = usePlugins()

    const grouped = plugins.reduce<Record<PluginCategory, Plugin[]>>(
        (acc, p) => {
            ;(acc[p.category] ??= []).push(p)
            return acc
        },
        { inference: [], tools: [], integrations: [] },
    )

    return (
        <Page
            title={
                <div className="plugins-page__title-row" role="tablist" aria-label="Plugins/Skills">
                    <button
                        type="button"
                        role="tab"
                        aria-selected="true"
                        className="plugins-page__pill plugins-page__pill--active"
                    >
                        Plugins
                    </button>
                    <button
                        type="button"
                        role="tab"
                        aria-selected="false"
                        className="plugins-page__pill"
                    >
                        Skills
                    </button>
                </div>
            }
        >
            {(Object.keys(grouped) as PluginCategory[]).map((cat) => {
                const list = grouped[cat]
                if (list.length === 0) return null
                return (
                    <section key={cat} className="plugins-section">
                        <h3 className="plugins-section__heading">{SECTION_LABELS[cat]}</h3>
                        <div className="plugins-section__list">
                            {list.map((p) => <PluginCard key={p.id} plugin={p} />)}
                        </div>
                    </section>
                )
            })}
        </Page>
    )
}
