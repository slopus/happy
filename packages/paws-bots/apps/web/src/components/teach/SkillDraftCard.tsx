import { Trans, useLingui } from "@lingui/react/macro";
import type { SkillPlaybook } from "@rakazo/contracts";
import { formatSkillRunPrompt } from "@rakazo/core";
import { Button, Input, Label, Textarea } from "@rakazo/ui-web";
import { useEffect, useId, useRef, useState } from "react";
import { rpc } from "../../lib/rpc";
import { errorText } from "../../lib/user-error";
import { BuiCard } from "../ai/primitives";

type SkillDraftBlock = {
  kind: "skill_draft";
  skillId: string;
  name: string;
  goal: string;
  playbook: SkillPlaybook;
  status: "draft" | "saved";
};

function fieldsOf(block: SkillDraftBlock): string {
  return JSON.stringify({ name: block.name, playbook: block.playbook });
}

function savedSnapshot(block: SkillDraftBlock): string | null {
  return block.status === "saved" ? fieldsOf(block) : null;
}

function fieldLabel(id: string, title: React.ReactNode) {
  return (
    <Label htmlFor={id} className="mt-3 mb-1 text-body-sm font-normal text-muted-foreground">
      {title}
    </Label>
  );
}

export function SkillDraftCard({
  block,
  onRefresh,
  onAddRoutine,
}: {
  block: SkillDraftBlock;
  onRefresh: () => Promise<void>;
  onAddRoutine: (name: string, prompt: string) => void;
}) {
  const { t } = useLingui();
  const id = useId();
  const [name, setName] = useState(block.name);
  const [playbook, setPlaybook] = useState(block.playbook);
  // What the server last saved; "Saved" shows only while the fields still match it.
  const [savedFields, setSavedFields] = useState(savedSnapshot(block));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saved = savedFields === JSON.stringify({ name, playbook });

  // The fields last loaded from the server, and whether this card has written since. A later
  // update to the same skill never replaces fields this card wrote or the user edited, so a
  // late or out-of-order saved status cannot bring back older values.
  const synced = useRef({ skillId: block.skillId, fields: fieldsOf(block), wrote: false });

  useEffect(() => {
    const sameSkill = synced.current.skillId === block.skillId;
    if (sameSkill && synced.current.wrote) {
      if (block.status === "saved") setSavedFields((current) => current ?? fieldsOf(block));
      return;
    }
    setSavedFields(savedSnapshot(block));
    if (sameSkill && synced.current.fields !== JSON.stringify({ name, playbook })) return;
    synced.current = { skillId: block.skillId, fields: fieldsOf(block), wrote: false };
    setName(block.name);
    setPlaybook(block.playbook);
  }, [block.skillId, block.status]);

  async function persist(then: (sent: string) => Promise<unknown>, failure?: string) {
    const sent = JSON.stringify({ name, playbook });
    setBusy(true);
    setError(null);
    try {
      await rpc.skills.updateDraft({ skillId: block.skillId, name, playbook });
      synced.current.wrote = true;
      // A saved skill stays saved with the fields just written.
      if (savedFields !== null) setSavedFields(sent);
      await then(sent);
    } catch (err) {
      setError(errorText(err, failure));
      setBusy(false);
      return;
    }
    // The write already succeeded, so a failed thread refresh is not reported as its failure.
    await onRefresh().catch(() => undefined);
    setBusy(false);
  }

  const saveDraft = () =>
    persist(async (sent) => {
      await rpc.skills.save({ skillId: block.skillId, name });
      setSavedFields(sent);
    }, t`Could not save skill`);

  const testDraft = () => persist(() => rpc.skills.testRun({ skillId: block.skillId }));

  const skillName = name || block.name || block.goal.slice(0, 80);

  return (
    <BuiCard data-testid="skill-draft-card" className="w-[520px] max-w-full px-5 py-4">
      <div className="text-body-lg font-medium text-foreground">
        <Trans>Draft skill</Trans>
      </div>
      <div className="mt-1 text-body text-muted-foreground">{block.goal}</div>
      {fieldLabel(`${id}-name`, <Trans>Name</Trans>)}
      <Input
        id={`${id}-name`}
        disabled={busy}
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      {fieldLabel(`${id}-when`, <Trans>When to use</Trans>)}
      <Textarea
        disabled={busy}
        id={`${id}-when`}
        value={playbook.whenToUse}
        onChange={(event) => setPlaybook({ ...playbook, whenToUse: event.target.value })}
        rows={2}
      />
      {fieldLabel(`${id}-inputs`, <Trans>Inputs</Trans>)}
      <Textarea
        disabled={busy}
        id={`${id}-inputs`}
        value={playbook.inputs.join("\n")}
        onChange={(event) =>
          setPlaybook({
            ...playbook,
            inputs: event.target.value.split("\n"),
          })
        }
        rows={2}
      />
      {fieldLabel(`${id}-steps`, <Trans>Steps</Trans>)}
      <Textarea
        disabled={busy}
        id={`${id}-steps`}
        value={playbook.steps.join("\n")}
        onChange={(event) =>
          setPlaybook({
            ...playbook,
            steps: event.target.value.split("\n"),
          })
        }
        rows={5}
      />
      {fieldLabel(`${id}-check`, <Trans>How to check</Trans>)}
      <Textarea
        disabled={busy}
        id={`${id}-check`}
        value={playbook.howToCheck}
        onChange={(event) => setPlaybook({ ...playbook, howToCheck: event.target.value })}
        rows={2}
      />
      {fieldLabel(`${id}-return`, <Trans>What to return</Trans>)}
      <Textarea
        disabled={busy}
        id={`${id}-return`}
        value={playbook.whatToReturn}
        onChange={(event) => setPlaybook({ ...playbook, whatToReturn: event.target.value })}
        rows={2}
      />
      {fieldLabel(`${id}-approval`, <Trans>Approval boundaries</Trans>)}
      <Textarea
        disabled={busy}
        id={`${id}-approval`}
        value={playbook.approvalBoundaries}
        onChange={(event) => setPlaybook({ ...playbook, approvalBoundaries: event.target.value })}
        rows={2}
      />
      {fieldLabel(`${id}-failure`, <Trans>Failure handling</Trans>)}
      <Textarea
        disabled={busy}
        id={`${id}-failure`}
        value={playbook.failureHandling}
        onChange={(event) => setPlaybook({ ...playbook, failureHandling: event.target.value })}
        rows={2}
      />
      <div className="mt-4 flex flex-wrap gap-2">
        <Button disabled={busy} onClick={() => void saveDraft()}>
          {saved ? <Trans>Saved</Trans> : busy ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
        </Button>
        <Button variant="outline" disabled={busy} onClick={() => void testDraft()}>
          <Trans>Test</Trans>
        </Button>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => onAddRoutine(skillName, formatSkillRunPrompt(skillName, playbook))}
        >
          <Trans>Add to routine</Trans>
        </Button>
      </div>
      {error ? <p className="mt-2 text-label text-destructive">{error}</p> : null}
    </BuiCard>
  );
}
