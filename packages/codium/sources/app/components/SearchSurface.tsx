import './SearchSurface.css'

export function SearchSurface() {
    return (
        <div className="search-surface" role="dialog" aria-label="Search preview">
            <input
                className="search-surface__input"
                value="settings"
                readOnly
                aria-label="Search"
            />
            <div className="search-surface__list">
                <div className="search-surface__group">Chats</div>
                <button type="button" className="search-surface__item">
                    Settings implementation notes
                </button>
                <div className="search-surface__group">Pages</div>
                <button type="button" className="search-surface__item search-surface__item--active">
                    Appearance settings
                </button>
                <button type="button" className="search-surface__item">
                    General settings
                </button>
            </div>
        </div>
    )
}
