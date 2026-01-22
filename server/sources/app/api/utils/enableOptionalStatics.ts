import type { FastifyInstance } from "fastify";
import { resolveUiConfig } from "@/app/api/uiConfig";
import { enableServeUi } from "./enableServeUi";
import { enablePublicFiles } from "./enablePublicFiles";

type AnyFastifyInstance = FastifyInstance<any, any, any, any, any>;

export function enableOptionalStatics(app: AnyFastifyInstance) {
    // Optional: serve a prebuilt web UI bundle (static directory).
    const ui = resolveUiConfig(process.env);
    const { dir: uiDir, mountRoot } = ui;
    if (!uiDir || !mountRoot) {
        app.get('/', function (_request, reply) {
            reply.send('Welcome to Happy Server!');
        });
    }

    enableServeUi(app, ui);

    // Local file serving for the light flavor (avatars/images/etc).
    // Enabled only when the selected files backend supports public reads.
    enablePublicFiles(app);
}
