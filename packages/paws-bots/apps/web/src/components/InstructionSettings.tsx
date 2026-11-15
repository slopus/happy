import { Trans, useLingui } from "@lingui/react/macro";
import { ORPCError } from "@orpc/client";
import type { Bot } from "@rakazo/contracts";
import { BOT_INSTRUCTIONS_MAX_LENGTH } from "@rakazo/contracts";
import { Button, Disclosure, Textarea } from "@rakazo/ui-web";
import { Popover, PopoverContent, PopoverTrigger } from "@rakazo/ui-web/components/ui/popover";
import { History } from "lucide-react";
import { useId, useState } from "react";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";

export function InstructionSettings({ bot }: { bot: Bot }) {
  const { t } = useLingui();
  const id = useId();
  const [previousBot, setPreviousBot] = useState(bot);
  const [current, setCurrent] = useState(bot);
  const [baseline, setBaseline] = useState(bot.instructions);
  const [instructions, setInstructions] = useState(bot.instructions);
  const [pending, setPending] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState("");
  if (bot !== previousBot) {
    setPreviousBot(bot);
    if (instructions === baseline) {
      setInstructions(bot.instructions);
      setBaseline(bot.instructions);
    }
    setCurrent(bot);
  }
  async function save(action: () => Promise<Bot>) {
    setPending(true);
    setError("");
    try {
      const updated = await action();
      setConflict(false);
      setCurrent(updated);
      setInstructions(updated.instructions);
      setBaseline(updated.instructions);
    } catch (err) {
      setError(errorText(err));
      setConflict((current) => current || (err instanceof ORPCError && err.code === "CONFLICT"));
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between pe-1">
        <label
          htmlFor={`${id}-instructions`}
          className="text-label font-medium text-muted-foreground"
        >
          <Trans>Instructions</Trans>
        </label>
        {current.instructionHistory?.length ? (
          <Popover>
            <PopoverTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t`Instruction history`}
                  title={t`Instruction history`}
                />
              }
            >
              <History className="size-4 text-muted-foreground" />
            </PopoverTrigger>
            <PopoverContent align="end" className="max-h-96 overflow-y-auto">
              {current.instructionHistory.map((version) => (
                <div key={version.id} className="mt-2 text-body">
                  <Disclosure
                    summary={
                      <span className="inline-flex flex-wrap gap-x-2">
                        <span>{new Date(version.createdAt).toLocaleString()}</span>
                        <span className="text-muted-foreground">{version.reason}</span>
                      </span>
                    }
                  >
                    <pre className="whitespace-pre-wrap">{version.instructions}</pre>
                  </Disclosure>
                  <Button
                    variant="outline"
                    disabled={pending}
                    onClick={() =>
                      void save(() =>
                        rpc.bots.restoreInstructions({
                          botId: bot.id,
                          versionId: version.id,
                          expectedInstructions: current.instructions,
                        }),
                      )
                    }
                  >
                    <Trans>Restore</Trans>
                  </Button>
                </div>
              ))}
            </PopoverContent>
          </Popover>
        ) : null}
      </div>
      <Textarea
        id={`${id}-instructions`}
        className="font-normal min-h-20 max-h-96 resize-none field-sizing-content text-foreground rounded-xl border-transparent bg-muted/50 p-4 shadow-none"
        value={instructions}
        maxLength={BOT_INSTRUCTIONS_MAX_LENGTH}
        disabled={pending}
        onChange={(event) => setInstructions(event.target.value)}
        onBlur={() => {
          if (!conflict && instructions !== current.instructions)
            void save(() =>
              rpc.bots.update({ botId: bot.id, instructions, expectedInstructions: baseline }),
            );
        }}
      />
      {error ? <p className="text-body text-destructive">{error}</p> : null}
      {conflict ? (
        <Button
          variant="outline"
          disabled={pending}
          onClick={() => void save(() => rpc.bots.get({ botId: bot.id }))}
        >
          <Trans>Reload</Trans>
        </Button>
      ) : null}
    </div>
  );
}
