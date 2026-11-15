import { hostNavigate } from "../paws/runtime";
import { Trans } from "@lingui/react/macro";
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  FieldError,
  FieldLabel,
  Input,
} from "@rakazo/ui-web";
import { useId, useState } from "react";
import { openOrganizationSpace, organizationsQuery } from "../lib/organizations";
import { queryClient, useQueryUserId } from "../lib/query";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";

/** Creates an organization and moves into it, where onboarding sets up its first bot. */
export function CreateOrganizationDialog({
  open,
  onOpenChange,
  openSpaceChat,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  openSpaceChat?: (spaceId: string, path: string) => void;
}) {
  const userId = useQueryUserId();
  const nameId = useId();
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    const trimmed = name.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    setError(null);
    try {
      const created = await rpc.organizations.create({ name: trimmed });
      await queryClient
        .fetchQuery({ ...organizationsQuery(userId), staleTime: 0 })
        .catch(() => undefined);
      // The new organization is listed even if this device cannot switch into it.
      if (
        !(await openOrganizationSpace(userId, created.defaultSpaceId, "/onboarding", openSpaceChat))
      )
        hostNavigate("/");
    } catch (reason) {
      setError(errorText(reason));
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (saving) return;
        onOpenChange(next);
        if (!next) {
          setName("");
          setError(null);
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            <Trans>Create organization</Trans>
          </DialogTitle>
        </DialogHeader>
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <Field>
            <FieldLabel htmlFor={nameId}>
              <Trans>Name</Trans>
            </FieldLabel>
            <Input
              id={nameId}
              maxLength={60}
              value={name}
              disabled={saving}
              onChange={(event) => {
                setName(event.target.value);
                setError(null);
              }}
              autoFocus
            />
            <FieldError>{error}</FieldError>
          </Field>
          <DialogFooter>
            <Button type="submit" disabled={saving || !name.trim()}>
              <Trans>Create</Trans>
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
