import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Stepper } from "./components/ui/stepper.js";

describe("Stepper", () => {
  it("reads out which steps are done and hides the drawn number and check", () => {
    const html = renderToString(
      <Stepper
        completeLabel="Erledigt"
        steps={[
          { id: "model", title: "Model", status: "complete" },
          { id: "apps", title: "Apps", status: "current" },
          { id: "bot", title: "Bot", status: "upcoming" },
        ]}
      />,
    );

    expect(html.match(/class="sr-only">Erledigt<\/span>/g)).toHaveLength(1);
    expect(html.match(/aria-current="step"/g)).toHaveLength(1);
    expect(html.match(/<span aria-hidden="true" class="relative grid size-8/g)).toHaveLength(3);
  });

  it("names a step that can be reopened with its title and status, whatever its id", () => {
    const html = renderToString(
      <Stepper
        completeLabel="Erledigt"
        onSelect={() => {}}
        steps={[
          { id: "model setup", title: "Model", status: "complete", selectable: true },
          { id: "apps", title: "Apps", status: "current" },
        ]}
      />,
    );
    const ids = html.match(/<button[^>]*aria-labelledby="([^"]+)"/)?.[1]?.split(" ") ?? [];

    expect(ids).toHaveLength(2);
    expect(html).toMatch(new RegExp(`id="${ids[0]}"[^>]*>Model<`));
    expect(html).toMatch(new RegExp(`id="${ids[1]}"[^>]*>Erledigt<`));
  });
});
