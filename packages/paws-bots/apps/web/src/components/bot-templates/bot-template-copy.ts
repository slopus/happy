import { useLingui } from "@lingui/react/macro";
import type { BotTemplate } from "@rakazo/contracts";

export type BotTemplateCopy = Pick<BotTemplate, "name" | "summary" | "sample">;

/**
 * Each template's name, summary and sample in the app's language. The English here must match
 * `BOT_TEMPLATES` (a test checks); a template without copy here shows the server's English.
 */
export function useBotTemplateCopy(): (template: BotTemplate) => BotTemplateCopy {
  const { t } = useLingui();
  return (template) => {
    switch (template.id) {
      case "morning-briefing":
        return {
          name: t`Morning briefing`,
          summary: t`Your day at a glance, every weekday morning`,
          sample: t`**Thursday**

**Calendar**
- 10:00 Design review, moved to 11:30
- 14:00 Call with Dana

**Needs you**
- Alex asked for the Q4 numbers by noon
- A contract is waiting for your signature

**Worth knowing**
- Light rain after 4pm
- Two stories on the topics you follow`,
        };
      case "inbox-triage":
        return {
          name: t`Inbox triage`,
          summary: t`Sorts new email and drafts the replies`,
          sample: t`**12 new since 8:00**

**Reply needed**
1. Priya wants to move Friday's review. Draft: "Friday works if we start at 2."
2. Your card expires on the 30th. Draft ready.
3. Sam asked about the API limits. Draft ready.

**For your information**: a shipping update and a calendar change

**Low priority**: 7 newsletters and notifications`,
        };
      case "pr-reviewer":
        return {
          name: t`PR reviewer`,
          summary: t`Reviews pull requests waiting on you`,
          sample: t`**2 pull requests are waiting on you**

**#482 Add retry to webhook delivery**
- Retries on 404 too, so a deleted endpoint is retried five times. Retry only 5xx and timeouts?
- No test for the backoff cap.

Suggested review: request changes.

**#479 Fix date parsing in reports**
Looks good. Suggested review: approve.`,
        };
      case "topic-watch":
        return {
          name: t`Topic watch`,
          summary: t`A weekly digest of what changed on topics you follow`,
          sample: t`**This week**

**Open-source AI agents**
- A major release adds scheduled tasks (3 days ago)
- Two new comparisons; both call memory the main gap

**competitor.example**
- Pricing: the Team plan went from $20 to $25 per seat

Nothing new on battery recycling.`,
        };
      default:
        return template;
    }
  };
}
