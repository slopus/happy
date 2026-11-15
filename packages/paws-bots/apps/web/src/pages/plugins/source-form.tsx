import { Trans } from "@lingui/react/macro";
import type {
  IntegrationCatalogResult,
  IntegrationCatalogSurface,
  McpSourcePreset,
} from "@rakazo/contracts";
import {
  Button,
  Field,
  FieldDescription,
  FieldLabel,
  Input,
  NativeSelect,
  NativeSelectOption,
} from "@rakazo/ui-web";
import { useState } from "react";
import { ViewTitle } from "./parts";

export type SourceKind = "mcp" | "api" | "graphql";

export type SourceForm = ReturnType<typeof useSourceForm>;

/** The fields of a custom MCP, OpenAPI, or GraphQL connector; each start fills them afresh. */
export function useSourceForm() {
  const [sourceKind, setSourceKind] = useState<SourceKind | null>(null);
  const [sourcePreset, setSourcePreset] = useState<McpSourcePreset | null>(null);
  const [sourceName, setSourceName] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [credential, setCredential] = useState("");
  const [authType, setAuthType] = useState<"none" | "bearer" | "header">("bearer");
  const [authName, setAuthName] = useState("x-api-key");
  const [sourceHint, setSourceHint] = useState<string | null>(null);

  function start(kind: SourceKind, preset: McpSourcePreset | null) {
    setSourceKind(kind);
    setSourcePreset(preset);
    setSourceHint(null);
    setSourceName(preset?.name ?? "");
    setSourceUrl(preset?.url ?? "");
    setCredential("");
    setAuthType(preset ? "bearer" : "none");
    setAuthName("x-api-key");
  }

  /** A domain search result prefills the form with what it found. */
  function startFromCatalog(
    result: IntegrationCatalogResult,
    surface: IntegrationCatalogSurface,
    source: string,
  ) {
    setSourceKind(surface.kind === "mcp" ? "mcp" : "api");
    setSourcePreset(null);
    setSourceName(result.name);
    setSourceUrl(source);
    setCredential("");
    setAuthType(surface.auth?.type ?? "none");
    setAuthName(surface.auth?.headerName ?? "x-api-key");
    setSourceHint(surface.auth?.note ?? null);
  }

  function close() {
    setSourceKind(null);
    setSourceHint(null);
  }

  return {
    sourceKind,
    setSourceKind,
    sourcePreset,
    sourceName,
    setSourceName,
    sourceUrl,
    setSourceUrl,
    credential,
    setCredential,
    authType,
    setAuthType,
    authName,
    setAuthName,
    sourceHint,
    start,
    startFromCatalog,
    close,
  };
}

export function SourceFormView({
  form,
  installing,
  sourceError,
  onBack,
  onSubmit,
}: {
  form: SourceForm;
  installing: boolean;
  sourceError: string | null;
  onBack: () => void;
  onSubmit: () => void;
}) {
  const {
    sourceKind,
    sourcePreset,
    sourceName,
    setSourceName,
    sourceUrl,
    setSourceUrl,
    credential,
    setCredential,
    authType,
    setAuthType,
    authName,
    setAuthName,
    sourceHint,
  } = form;
  if (!sourceKind) return null;
  const custom = !sourcePreset;
  return (
    <div data-testid="integrations-source-form" className="max-w-xl space-y-6">
      <ViewTitle
        title={
          sourcePreset ? (
            sourcePreset.name
          ) : sourceKind === "mcp" ? (
            <Trans>MCP server</Trans>
          ) : sourceKind === "graphql" ? (
            "GraphQL"
          ) : (
            "OpenAPI"
          )
        }
        onBack={onBack}
      />
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <Field>
          <FieldLabel htmlFor="source-name">
            <Trans>Name</Trans>
          </FieldLabel>
          <Input
            id="source-name"
            value={sourceName}
            onChange={(event) => setSourceName(event.target.value)}
            autoFocus
          />
        </Field>
        {!sourcePreset?.url ? (
          <Field>
            <FieldLabel htmlFor="source-url">URL</FieldLabel>
            <Input
              id="source-url"
              value={sourceUrl}
              onChange={(event) => setSourceUrl(event.target.value)}
              placeholder={
                sourcePreset?.urlPlaceholder ??
                (sourceKind === "mcp"
                  ? "https://example.com/mcp"
                  : sourceKind === "graphql"
                    ? "https://example.com/graphql"
                    : "https://example.com/openapi.json")
              }
            />
          </Field>
        ) : null}
        {custom ? (
          <Field>
            <FieldLabel htmlFor="source-auth">
              <Trans>Authentication</Trans>
            </FieldLabel>
            <NativeSelect
              id="source-auth"
              className="w-full"
              value={authType}
              onChange={(event) => setAuthType(event.target.value as typeof authType)}
            >
              <NativeSelectOption value="none">
                <Trans>No authentication</Trans>
              </NativeSelectOption>
              <NativeSelectOption value="bearer">
                <Trans>Bearer token</Trans>
              </NativeSelectOption>
              <NativeSelectOption value="header">
                <Trans>API key header</Trans>
              </NativeSelectOption>
            </NativeSelect>
          </Field>
        ) : null}
        {custom && authType === "header" ? (
          <Field>
            <FieldLabel htmlFor="source-header">
              <Trans>Header name</Trans>
            </FieldLabel>
            <Input
              id="source-header"
              value={authName}
              onChange={(event) => setAuthName(event.target.value)}
            />
          </Field>
        ) : null}
        {!custom || authType !== "none" ? (
          <Field>
            <FieldLabel htmlFor="source-credential">
              {sourcePreset ? <Trans>Bearer token</Trans> : <Trans>Credential</Trans>}
            </FieldLabel>
            <Input
              id="source-credential"
              type="password"
              autoComplete="new-password"
              value={credential}
              onChange={(event) => setCredential(event.target.value)}
            />
            <FieldDescription>
              <Trans>Credentials are encrypted and never sent to the model.</Trans>
            </FieldDescription>
          </Field>
        ) : null}
        {sourceHint ? <p className="text-body text-muted-foreground">{sourceHint}</p> : null}
        {sourceError ? (
          <p role="alert" className="text-body text-destructive">
            {sourceError}
          </p>
        ) : null}
        <Button type="submit" disabled={installing}>
          {installing ? <Trans>Verifying…</Trans> : <Trans>Verify and add</Trans>}
        </Button>
      </form>
    </div>
  );
}
