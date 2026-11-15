import { Trans, useLingui } from "@lingui/react/macro";
import type { SignupSurvey as SignupSurveyAnswers } from "@rakazo/contracts";
import {
  SIGNUP_SURVEY_TEAM_SIZES,
  signupSurveyAsksTeamSize,
  signupSurveyTeamSizeLabel,
} from "@rakazo/contracts";
import {
  Button,
  Input,
  OptionSelect,
  Textarea,
  ToggleGroup,
  ToggleGroupItem,
} from "@rakazo/ui-web";
import { useId, useState } from "react";
import { rpc } from "../lib/rpc";

type Use = NonNullable<SignupSurveyAnswers["use"]>;
type TeamSize = NonNullable<SignupSurveyAnswers["teamSize"]>;

const TEAM_SIZE_OPTIONS = SIGNUP_SURVEY_TEAM_SIZES.map((value) => ({
  value,
  label: signupSurveyTeamSizeLabel(value),
}));

export function SignupSurvey({ onDone }: { onDone: () => void }) {
  const { t } = useLingui();
  const fieldId = useId();
  const [reason, setReason] = useState("");
  const [use, setUse] = useState<Use | null>(null);
  const [teamSize, setTeamSize] = useState<TeamSize | null>(null);
  const [source, setSource] = useState("");

  function submit() {
    // Answers are optional, so a slow or failed save never holds up onboarding.
    void rpc.onboarding
      .signupSurvey({
        reason: reason.trim() || undefined,
        use: use ?? undefined,
        teamSize: signupSurveyAsksTeamSize(use ?? undefined) ? (teamSize ?? undefined) : undefined,
        source: source.trim() || undefined,
      })
      .catch(() => undefined);
    onDone();
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <h1 className="text-display font-medium text-foreground">
        <Trans>Welcome to Rakazo</Trans>
      </h1>
      <p id={`${fieldId}-use`} className="mt-8 text-body font-medium text-foreground">
        <Trans>How will you use Rakazo?</Trans>
      </p>
      <ToggleGroup
        aria-labelledby={`${fieldId}-use`}
        value={use ? [use] : []}
        onValueChange={([next]) => setUse((next as Use | undefined) ?? null)}
        spacing={1}
        className="mt-2 grid w-full grid-cols-3 rounded-lg bg-muted p-1"
      >
        <ToggleGroupItem
          value="personal"
          className="aria-pressed:bg-background aria-pressed:shadow-sm"
        >
          <Trans>Personal</Trans>
        </ToggleGroupItem>
        <ToggleGroupItem value="work" className="aria-pressed:bg-background aria-pressed:shadow-sm">
          <Trans>Work</Trans>
        </ToggleGroupItem>
        <ToggleGroupItem value="both" className="aria-pressed:bg-background aria-pressed:shadow-sm">
          <Trans>Both</Trans>
        </ToggleGroupItem>
      </ToggleGroup>
      {signupSurveyAsksTeamSize(use ?? undefined) ? (
        <>
          <label
            htmlFor={`${fieldId}-team-size`}
            className="mt-6 block text-body font-medium text-foreground"
          >
            <Trans>How big is your team?</Trans>
          </label>
          <OptionSelect
            id={`${fieldId}-team-size`}
            value={teamSize}
            options={TEAM_SIZE_OPTIONS}
            onValueChange={setTeamSize}
            className="mt-2"
          />
        </>
      ) : null}
      <label
        htmlFor={`${fieldId}-source`}
        className="mt-6 block text-body font-medium text-foreground"
      >
        <Trans>How did you hear about us?</Trans>
      </label>
      <Input
        id={`${fieldId}-source`}
        value={source}
        onChange={(event) => setSource(event.target.value)}
        maxLength={500}
        className="mt-2"
      />
      <label
        htmlFor={`${fieldId}-reason`}
        className="mt-6 block text-body font-medium text-foreground"
      >
        <Trans>What do you most want Rakazo to help with?</Trans>
      </label>
      <Textarea
        id={`${fieldId}-reason`}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        maxLength={2000}
        rows={3}
        placeholder={t`Optional`}
        className="mt-2"
      />
      <Button type="submit" className="mt-8">
        <Trans>Continue</Trans>
      </Button>
    </form>
  );
}
