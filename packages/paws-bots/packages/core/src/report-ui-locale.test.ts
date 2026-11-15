import { expect, it } from "vitest";
import { reportUiLocale } from "./ui-locale.js";

it("repairs an older startup write that lands after a language choice", async () => {
  let locale = "en";
  let saved = "es";
  let finishStartup: () => void = () => {};
  const writes: string[] = [];
  const startup = reportUiLocale(
    () => locale,
    async (value) => {
      writes.push(value);
      if (writes.length === 1) {
        await new Promise<void>((resolve) => {
          finishStartup = resolve;
        });
      }
      saved = value;
    },
  );
  locale = "de";
  await reportUiLocale(
    () => locale,
    async (value) => {
      saved = value;
    },
  );
  finishStartup();
  await startup;
  expect(saved).toBe("de");
  expect(writes).toEqual(["en", "de"]);
});

it("propagates failed writes without retrying", async () => {
  let writes = 0;
  await expect(
    reportUiLocale(
      () => "es",
      async () => {
        writes++;
        throw new Error("offline");
      },
    ),
  ).rejects.toThrow("offline");
  expect(writes).toBe(1);
});
