import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { createRoot } from "react-dom/client";
import { ChartBlockView } from "../../src/pages/shell/message-cards";
import { bubbleFrameWidth } from "../../src/pages/shell/transcript";
import "../../src/styles.css";

const params = new URLSearchParams(location.search);
const href = params.get("href") ?? "#details";
const i18n = setupI18n({ locale: "en", messages: { en: {} } });

createRoot(document.getElementById("root")!).render(
  <I18nProvider i18n={i18n}>
    <main className="min-h-screen bg-background px-4 py-5 text-foreground md:px-7 md:py-6">
      <div className="group/message relative hover:z-[1]">
        <div className="relative flex justify-start">
          <div
            data-testid="message-bubble-frame"
            className={`relative w-fit min-w-0 ${bubbleFrameWidth("bot")}`}
          >
            <div className="relative flex flex-col gap-2">
              <div className="flex justify-start">
                <ChartBlockView
                  name="chart.png"
                  spec={{
                    title: "Linked chart",
                    marks: [
                      {
                        type: "dot",
                        options: {
                          x: "x",
                          y: "y",
                          href: "url",
                          fill: "currentColor",
                          r: 12,
                          tip: params.get("inspect") === "1",
                        },
                      },
                    ],
                  }}
                  data={[{ x: 1, y: 1, url: href }]}
                />
              </div>
            </div>
          </div>
        </div>
      </div>
      <div id="details">Chart details</div>
    </main>
  </I18nProvider>,
);
