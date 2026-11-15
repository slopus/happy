import type { ComputerProviderDescriptor, ComputerProviderField } from "@rakazo/contracts";
import {
  ipVersion,
  isCloudMetadataHost,
  isInternalHostname,
  isNonPublicAddress,
} from "@rakazo/contracts";
import type { SandboxProviderOptions } from "./sandbox-factory.js";
import { sandboxProviderOptionsFromEnv } from "./sandbox-provider-env.js";

export interface SettingsComputerProvider extends ComputerProviderDescriptor {
  verify(values: Record<string, string>): SandboxProviderOptions;
  verifyConnection?(values: Record<string, string>, signal: AbortSignal): Promise<void>;
}

/** Env and Settings share the factory's option mapping and constructors. */
export function defineComputerProvider(
  descriptor: ComputerProviderDescriptor,
  bindings: Record<string, string>,
): SettingsComputerProvider {
  const controlled = Object.fromEntries(
    Object.entries(
      sandboxProviderOptionsFromEnv(
        Object.fromEntries(Object.values(bindings).map((name) => [name, "1"])),
      ),
    ).filter(([, value]) => value !== undefined),
  );
  return {
    ...descriptor,
    verify(values) {
      const env: NodeJS.ProcessEnv = {};
      for (const key of Object.keys(values)) {
        if (!Object.hasOwn(bindings, key)) throw new Error("Unknown computer setting");
      }
      for (const field of descriptor.fields) {
        const value = values[field.key]?.trim() ?? "";
        if (field.required && !value) throw new Error(`${field.label} is required`);
        if (value.length > 4096) throw new Error(`${field.label} is too long`);
        if (value && field.kind === "url") {
          const url = new URL(value);
          if (url.protocol !== "https:" || url.username || url.password || url.hash)
            throw new Error(`${field.label} must be an HTTPS URL without credentials or fragment`);
          const host = url.hostname.replace(/^\[|\]$/g, "");
          if (
            isInternalHostname(host) ||
            isCloudMetadataHost(host) ||
            (ipVersion(host) && isNonPublicAddress(host))
          )
            throw new Error(`${field.label} must use a public address`);
        }
        if (
          field.kind === "select" &&
          value &&
          !field.options?.some((option) => option.value === value)
        )
          throw new Error(`Invalid ${field.label}`);
        env[bindings[field.key]!] = value || undefined;
      }
      // Only the options these fields set: a blank one falls back to the provider's default,
      // and options Settings has no field for keep their environment values.
      const options = sandboxProviderOptionsFromEnv(env) as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(controlled).map((key) => [key, options[key]]),
      ) as SandboxProviderOptions;
    },
  };
}

export function defineApiComputerProvider(
  id: string,
  displayName: string,
  fields: [
    key: string,
    env: string,
    label: string,
    kind: ComputerProviderField["kind"],
    required: boolean,
  ][],
) {
  return defineComputerProvider(
    {
      id,
      displayName,
      capabilities: { perAccount: false },
      fields: fields.map(([key, , label, kind, required]) => ({
        key,
        label,
        kind,
        required,
        ...(kind === "url" ? { validation: "public-https" as const } : {}),
      })),
    },
    Object.fromEntries(fields.map(([key, env]) => [key, env])),
  );
}
