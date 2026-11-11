//! Process-wide state shared by every request and socket.

use crate::activity::ActivityCache;
use crate::auth::Auth;
use crate::config::Config;
use crate::events::Hub;
use crate::http::Router;
use crate::metrics::Metrics;
use crate::storage::files::Files;
use sqlx::PgPool;
use std::sync::Arc;

pub struct App {
    pub config: Config,
    pub pool: PgPool,
    pub auth: Auth,
    pub router: Router,
    pub hub: Hub,
    pub metrics: Arc<Metrics>,
    pub files: Files,
    pub activity: ActivityCache,
}

impl App {
    pub fn new(config: Config, pool: PgPool) -> App {
        let metrics = Arc::new(Metrics::new());
        let mut router = Router::default();
        crate::routes::register(&mut router, &config);
        App {
            auth: Auth::new(&config.master_secret),
            files: Files::new(&config),
            activity: ActivityCache::new(pool.clone(), metrics.clone()),
            hub: Hub::default(),
            router,
            metrics,
            pool,
            config,
        }
    }
}
