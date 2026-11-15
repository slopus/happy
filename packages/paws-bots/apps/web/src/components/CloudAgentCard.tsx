import { Trans } from "@lingui/react/macro";
import type { MessageBlock } from "@rakazo/contracts";
import { cloudAgentHttpsUrl } from "@rakazo/core";
import { Badge } from "@rakazo/ui-web/components/ui/badge";
import { Card, CardContent } from "@rakazo/ui-web/components/ui/card";

export function CloudAgentCard({
  block,
}: {
  block: Extract<MessageBlock, { kind: "cloud_agent" }>;
}) {
  const prHref = cloudAgentHttpsUrl(block.prUrl);
  const href = prHref ?? cloudAgentHttpsUrl(block.url);
  const content = (
    <Card size="sm" className="w-80 max-w-full" data-testid="cloud-agent-card">
      <CardContent className="flex flex-col gap-2">
        <div className="flex items-start justify-between gap-3">
          <span className="font-medium" dir="auto">
            {block.title}
          </span>
          <Badge
            variant="secondary"
            className={
              block.status === "failed"
                ? "text-destructive"
                : block.status === "finished"
                  ? "text-success"
                  : "text-muted-foreground"
            }
          >
            {block.status === "running" ? (
              <Trans>running</Trans>
            ) : block.status === "finished" ? (
              <Trans>finished</Trans>
            ) : block.status === "cancelled" ? (
              <Trans>cancelled</Trans>
            ) : block.status === "expired" ? (
              <Trans>expired</Trans>
            ) : (
              <Trans>failed</Trans>
            )}
          </Badge>
        </div>
        {prHref ? (
          <span className="text-muted-foreground">
            <Trans>Pull request</Trans>
          </span>
        ) : block.branch ? (
          <span className="text-muted-foreground" dir="auto">
            {block.branch}
          </span>
        ) : null}
      </CardContent>
    </Card>
  );
  return href ? (
    <a href={href} target="_blank" rel="noreferrer" className="block max-w-full no-underline">
      {content}
    </a>
  ) : (
    content
  );
}
