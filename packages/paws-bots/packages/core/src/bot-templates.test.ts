import { BotTemplateSchema } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { looksLikeCredential } from "./agent-import/index.js";
import { extractRoutineSkillMentions } from "./agent-skill.js";
import { BOT_TEMPLATES, findBotTemplate } from "./bot-templates.js";
import { presetFromCron } from "./cron.js";
import { matchFeaturedConnectorId } from "./featured-connectors.js";

describe("bot templates", () => {
  it("each validates strictly and has a unique id", () => {
    for (const template of BOT_TEMPLATES) {
      expect(BotTemplateSchema.parse(template)).toEqual(template);
    }
    const ids = BOT_TEMPLATES.map((template) => template.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(findBotTemplate("morning-briefing")?.name).toBe("Morning briefing");
    expect(findBotTemplate("missing")).toBeUndefined();
  });

  it("carry nothing shaped like a credential", () => {
    for (const template of BOT_TEMPLATES) {
      const texts = [
        template.sample,
        template.instructions,
        ...template.skills.flatMap((skill) => [skill.description, skill.body]),
        ...template.routines.map((routine) => routine.prompt),
      ];
      expect(texts.filter(looksLikeCredential)).toEqual([]);
    }
  });

  it("mention only their own skills, and every skill is used by a routine", () => {
    for (const template of BOT_TEMPLATES) {
      const names = template.skills.map((skill) => skill.name);
      const mentioned = template.routines.flatMap((routine) =>
        extractRoutineSkillMentions(routine.prompt),
      );
      expect(new Set(mentioned)).toEqual(new Set(names));
    }
  });

  it("use schedules the routine editor shows without Advanced", () => {
    for (const template of BOT_TEMPLATES) {
      for (const cron of template.routines.flatMap((routine) => routine.crons)) {
        expect(presetFromCron(cron).freq).not.toBe("Advanced");
      }
    }
  });

  it("name apps the connection catalog knows", () => {
    // Featured apps match by alias; the code host is matched by its own slug.
    for (const app of BOT_TEMPLATES.flatMap((template) => template.apps)) {
      expect(app === "github" || matchFeaturedConnectorId(app) !== null).toBe(true);
    }
  });
});
