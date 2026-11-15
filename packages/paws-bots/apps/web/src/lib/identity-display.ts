import { t } from "@lingui/core/macro";
import type { IdentityLabels } from "@rakazo/core";

export function identityLabels(): IdentityLabels {
  return {
    bot: t`Bot`,
    group: t`Group`,
    space: t`Space`,
    chats: t`Chats`,
    routine: t`Routine`,
    member: t`Member`,
    subagent: t`subagent`,
    owner: t`Owner`,
  };
}
