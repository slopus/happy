import { Trans } from "@lingui/react/macro";
import { useEffect } from "react";

export function IntegrationCallbackPage() {
  useEffect(() => {
    // The original app verifies the connection with the backend. This window
    // only finishes the browser flow, including when OAuth has severed opener.
    window.close();
  }, []);

  return (
    <div className="grid min-h-screen place-items-center bg-background p-6 text-center text-muted-foreground">
      <p>
        <Trans>You can close this window.</Trans>
      </p>
    </div>
  );
}
