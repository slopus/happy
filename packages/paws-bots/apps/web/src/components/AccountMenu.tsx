import { Trans, useLingui } from "@lingui/react/macro";
import { canDeleteOrganization } from "@rakazo/core";
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@rakazo/ui-web";
import { CircleUserRound } from "lucide-react";
import { useState } from "react";
import { authClient } from "../lib/auth";
import { switchOrganization, useOrganizations } from "../lib/organizations";
import { useQueryUserId } from "../lib/query";
import { DeleteOrganizationDialog, removeOrganization } from "../pages/OrganizationSettingsPanel";
import { DeleteAccountForm, hasDeleteRedirectError } from "./AccountAccess";

/**
 * The way out before the app opens (plan choice, onboarding): switch organization, delete an
 * unwanted one, log out or delete the account, without reaching settings.
 */
export function AccountMenu({
  disabled,
  signingOut,
  onLogOut,
}: {
  disabled?: boolean;
  signingOut: boolean;
  onLogOut: () => void;
}) {
  const { t } = useLingui();
  const email = authClient.useSession().data?.user.email;
  const userId = useQueryUserId();
  const { organizations, activeOrganizationId } = useOrganizations();
  // An SSO sign-in to confirm deletion returns here; reopen so its error is seen.
  const [deleting, setDeleting] = useState(hasDeleteRedirectError);
  const [deletingOrganization, setDeletingOrganization] = useState(false);
  const active = organizations.find((organization) => organization.id === activeOrganizationId);
  const deletableOrganization =
    active && canDeleteOrganization(organizations, active) ? active : null;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={t`Account`}
          data-testid="account-menu"
          disabled={disabled || signingOut}
          render={
            <Button
              variant="ghost"
              size="icon"
              className="fixed top-4 right-6 text-muted-foreground"
            />
          }
        >
          <CircleUserRound />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-auto min-w-48">
          {email ? (
            <>
              <DropdownMenuGroup>
                <DropdownMenuLabel>{email}</DropdownMenuLabel>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
            </>
          ) : null}
          {organizations.length > 1 ? (
            <>
              <DropdownMenuRadioGroup
                value={activeOrganizationId}
                onValueChange={(id) => {
                  const organization = organizations.find((candidate) => candidate.id === id);
                  if (organization && id !== activeOrganizationId)
                    void switchOrganization(userId, organization);
                }}
              >
                {organizations.map((organization) => (
                  <DropdownMenuRadioItem key={organization.id} value={organization.id}>
                    <span className="min-w-0 truncate">{organization.name}</span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
            </>
          ) : null}
          {deletableOrganization ? (
            <DropdownMenuItem onClick={() => setDeletingOrganization(true)}>
              <Trans>Delete organization</Trans>
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onClick={onLogOut}>
            <Trans>Log out</Trans>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setDeleting(true)}>
            <Trans>Delete account</Trans>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={deleting} onOpenChange={setDeleting}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              <Trans>Delete account</Trans>
            </DialogTitle>
          </DialogHeader>
          <DeleteAccountForm open />
        </DialogContent>
      </Dialog>
      {deletingOrganization && deletableOrganization ? (
        <DeleteOrganizationDialog
          organization={deletableOrganization}
          onCancel={() => setDeletingOrganization(false)}
          onConfirm={() => removeOrganization(deletableOrganization)}
        />
      ) : null}
    </>
  );
}
