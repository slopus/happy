import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { Select, SelectTrigger, SelectValue } from "./components/ui/select.js";

it("renders the chevron without adding Base UI's fallback arrow to the trigger text", () => {
  const html = renderToStaticMarkup(
    <Select value="high" items={[{ value: "high", label: "High" }]}>
      <SelectTrigger aria-label="Thinking">
        <SelectValue />
      </SelectTrigger>
    </Select>,
  );

  expect(html).toContain("High");
  expect(html).toContain("lucide-chevron-down");
  expect(html).not.toContain("▼");
});
