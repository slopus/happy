import { useLingui } from "@lingui/react/macro";
import type { AgentImportNeed, AgentImportStatus } from "@rakazo/contracts";

/** Short labels for what an imported item needs, shared by the preview and the chat checklist. */
export function useImportStatusText() {
  const { t } = useLingui();
  const need = (item: AgentImportNeed): string => {
    switch (item.kind) {
      case "api_key": {
        const provider = item.provider;
        return t`API key for ${provider}`;
      }
      case "credentials": {
        const names = item.names.join(", ");
        return t`Credentials: ${names}`;
      }
      case "env": {
        const names = item.names.join(", ");
        return t`Environment variables: ${names}`;
      }
      case "program": {
        const name = item.name;
        return t`Program: ${name}`;
      }
      case "local_paths":
        return t`Uses paths on your computer`;
      case "requires": {
        const names = item.names.join(", ");
        return t`Needs: ${names}`;
      }
      case "turn_on":
        return t`Paused`;
      case "bundled_files":
        return t`Uses files that are not imported`;
    }
  };
  const status = (value: AgentImportStatus): string => {
    switch (value.kind) {
      case "ready":
        return t`Ready`;
      case "needs_setup":
        return value.needs.map(need).join(", ");
      case "needs_review":
        return t`Contains code to run`;
      case "unsupported":
        return value.reason === "not_in_catalog"
          ? t`Not in Rakazo's catalog`
          : t`Not supported in Rakazo`;
    }
  };
  return { need, status };
}
