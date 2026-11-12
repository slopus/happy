//! Process-wide state shared by every request and socket.

use crate::activity::ActivityCache;
use crate::auth::Auth;
use crate::config::Config;
use crate::engine::Engine;
use crate::events::Hub;
use crate::http::Router;
use crate::metrics::Metrics;
use crate::storage::files::Files;
use crate::writer::Writers;
use sqlx::PgPool;
use std::sync::Arc;

pub struct App {
    pub config: Config,
    pub pool: PgPool,
    pub auth: Auth,
    pub router: Router,
    pub hub: Hub,
    pub engine: Engine,
    pub metrics: Arc<Metrics>,
    pub files: Files,
    pub activity: ActivityCache,
    pub writers: Writers,
    pub history: crate::history::History,
}

impl App {
    pub fn new(config: Config, pool: PgPool) -> App {
        let metrics = Arc::new(Metrics::new());
        let mut router = Router::default();
        crate::routes::register(&mut router, &config);
        App {
            auth: Auth::new(&config.master_secret),
            files: Files::new(&config),
            history: crate::history::History::new(&config),
            activity: ActivityCache::new(pool.clone(), metrics.clone()),
            hub: Hub::default(),
            writers: Writers::default(),
            engine: Engine::default(),
            router,
            metrics,
            pool,
            config,
        }
    }
}
