import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { DEFAULT_BOT_AVATAR_COLOR } from "@rakazo/ui-web";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { PeerMessagesOverlay } from "../../src/pages/PeerMessagesOverlay";
import "../../src/styles.css";

const i18n = setupI18n({ locale: "en", messages: { en: {} } });
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
createRoot(document.getElementById("root")!).render(
  <I18nProvider i18n={i18n}>
    <QueryClientProvider client={client}>
      <PeerMessagesOverlay
        botId="chief"
        botName="Chief"
        botColor={DEFAULT_BOT_AVATAR_COLOR}
        peerBotId="peer"
        peerBotName="Researcher"
        peerBotColor={DEFAULT_BOT_AVATAR_COLOR}
        onClose={() => undefined}
      />
    </QueryClientProvider>
  </I18nProvider>,
);
