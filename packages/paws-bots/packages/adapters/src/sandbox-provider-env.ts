import type { SandboxProviderOptions } from "./sandbox-factory.js";

/** Empty or remote provider without a key becomes none so services can boot for signup. */
export function resolveSandboxProvider(source: NodeJS.ProcessEnv = process.env): string {
  const configured = source.SANDBOX_PROVIDER;
  if (configured !== undefined && !configured.trim()) return "none";
  const requested = configured?.trim() || "docker";
  if (requested === "none") return "none";
  if (requested === "e2b" && !optional(source.E2B_API_KEY)) return "none";
  if (requested === "novita" && !optional(source.NOVITA_API_KEY)) return "none";
  if (requested === "daytona" && !optional(source.DAYTONA_API_KEY)) return "none";
  if (requested === "createos" && !optional(source.CREATEOS_SANDBOX_API_KEY)) return "none";
  if (requested === "boat" && !boatApiKeyFromEnv(source)) return "none";
  if (requested === "boxd" && !optional(source.BOXD_API_KEY)) return "none";
  if (requested === "instabox" && !optional(source.INSTABOX_API_KEY)) return "none";
  if (
    requested === "wuying" &&
    [
      source.WUYING_ACCESS_KEY_ID,
      source.WUYING_ACCESS_KEY_SECRET,
      source.WUYING_DESKTOP_ID,
      source.WUYING_END_USER_ID,
      source.WUYING_MCP_URL,
      source.WUYING_MCP_TOKEN,
    ].some((value) => !optional(value))
  )
    return "none";
  if (
    requested === "incus" &&
    [
      source.INCUS_SANDBOX_URL,
      source.INCUS_SANDBOX_CLIENT_CERT,
      source.INCUS_SANDBOX_CLIENT_KEY,
    ].some((value) => !optional(value))
  )
    return "none";
  if (
    requested === "railway" &&
    (!optional(source.RAILWAY_API_TOKEN) || !optional(source.RAILWAY_ENVIRONMENT_ID))
  )
    return "none";
  // Production without a supervisor token cannot run Docker computers; boot as none instead of exiting.
  if (
    requested === "docker" &&
    source.NODE_ENV === "production" &&
    !optional(source.SANDBOX_SUPERVISOR_TOKEN)
  ) {
    return "none";
  }
  return requested;
}

export function sandboxProviderOptionsFromEnv(
  source: NodeJS.ProcessEnv = process.env,
): Pick<
  SandboxProviderOptions,
  | "hostComputerUrl"
  | "hostComputerToken"
  | "e2bApiKey"
  | "novitaApiKey"
  | "sandboxTemplate"
  | "daytonaApiKey"
  | "daytonaApiUrl"
  | "daytonaTarget"
  | "createosApiKey"
  | "createosBaseUrl"
  | "createosShape"
  | "createosRootfs"
  | "railwayApiToken"
  | "railwayEnvironmentId"
  | "railwayMaxWorkspaceFileBytes"
  | "railwaySandboxRegion"
  | "boatApiKey"
  | "boatApiUrl"
  | "boxdApiKey"
  | "boxdOrg"
  | "instaboxApiKey"
  | "kubernetesNamespace"
  | "kubernetesRuntimeClassName"
  | "kubernetesComputerImage"
  | "kubernetesCpuLimit"
  | "kubernetesMemoryLimit"
  | "kubernetesPodAnnotations"
  | "kubernetesPodLabels"
  | "kubernetesReadyTimeoutMs"
  | "kubernetesHomeClaim"
  | "kubernetesHomeColocateNamespace"
  | "kubernetesHomeColocateLabels"
  | "incusUrl"
  | "incusClientCert"
  | "incusClientKey"
  | "incusServerCert"
  | "incusProject"
  | "incusComputerImage"
  | "incusCpuLimit"
  | "incusMemoryLimit"
  | "incusProcessLimit"
  | "localVmCli"
  | "localVmComputerImage"
  | "localVmCpus"
  | "localVmMemory"
  | "wuyingAccessKeyId"
  | "wuyingAccessKeySecret"
  | "wuyingRegionId"
  | "wuyingDesktopId"
  | "wuyingEndUserId"
  | "wuyingMcpUrl"
  | "wuyingMcpToken"
> {
  return {
    hostComputerUrl: source.SANDBOX_HOST_URL,
    hostComputerToken: source.SANDBOX_HOST_TOKEN,
    e2bApiKey: source.E2B_API_KEY,
    novitaApiKey: optional(source.NOVITA_API_KEY),
    sandboxTemplate: optional(source.SANDBOX_TEMPLATE),
    daytonaApiKey: source.DAYTONA_API_KEY,
    daytonaApiUrl: source.DAYTONA_API_URL,
    daytonaTarget: source.DAYTONA_TARGET,
    createosApiKey: source.CREATEOS_SANDBOX_API_KEY,
    createosBaseUrl: source.CREATEOS_SANDBOX_BASE_URL,
    createosShape: source.CREATEOS_SANDBOX_SHAPE,
    createosRootfs: source.CREATEOS_SANDBOX_ROOTFS,
    railwayApiToken: source.RAILWAY_API_TOKEN,
    railwayEnvironmentId: source.RAILWAY_ENVIRONMENT_ID,
    railwayMaxWorkspaceFileBytes: source.RAILWAY_MAX_WORKSPACE_FILE_BYTES,
    railwaySandboxRegion: optional(source.RAILWAY_SANDBOX_REGION),
    boatApiKey: boatApiKeyFromEnv(source),
    boatApiUrl: boatApiUrlFromEnv(source),
    boxdApiKey: optional(source.BOXD_API_KEY),
    boxdOrg: optional(source.BOXD_ORG),
    instaboxApiKey: optional(source.INSTABOX_API_KEY),
    kubernetesNamespace: optional(source.KUBERNETES_SANDBOX_NAMESPACE),
    kubernetesRuntimeClassName: optional(source.KUBERNETES_SANDBOX_RUNTIME_CLASS_NAME),
    kubernetesComputerImage: optional(source.KUBERNETES_SANDBOX_COMPUTER_IMAGE),
    kubernetesCpuLimit: optional(source.KUBERNETES_SANDBOX_CPU_LIMIT),
    kubernetesMemoryLimit: optional(source.KUBERNETES_SANDBOX_MEMORY_LIMIT),
    kubernetesPodAnnotations: stringMap(
      source.KUBERNETES_SANDBOX_POD_ANNOTATIONS,
      "KUBERNETES_SANDBOX_POD_ANNOTATIONS",
    ),
    kubernetesPodLabels: stringMap(
      source.KUBERNETES_SANDBOX_POD_LABELS,
      "KUBERNETES_SANDBOX_POD_LABELS",
    ),
    kubernetesReadyTimeoutMs: positiveInteger(
      source.KUBERNETES_SANDBOX_READY_TIMEOUT_MS,
      "KUBERNETES_SANDBOX_READY_TIMEOUT_MS",
    ),
    kubernetesHomeClaim: optional(source.OBJECT_STORAGE_BUCKET)
      ? undefined
      : optional(source.KUBERNETES_SANDBOX_HOME_CLAIM),
    kubernetesHomeColocateNamespace: optional(source.KUBERNETES_SANDBOX_HOME_COLOCATE_NAMESPACE),
    kubernetesHomeColocateLabels: stringMap(
      source.KUBERNETES_SANDBOX_HOME_COLOCATE_LABELS,
      "KUBERNETES_SANDBOX_HOME_COLOCATE_LABELS",
    ),
    incusUrl: optional(source.INCUS_SANDBOX_URL),
    incusClientCert: pem(source.INCUS_SANDBOX_CLIENT_CERT),
    incusClientKey: pem(source.INCUS_SANDBOX_CLIENT_KEY),
    incusServerCert: pem(source.INCUS_SANDBOX_SERVER_CERT),
    incusProject: optional(source.INCUS_SANDBOX_PROJECT),
    incusComputerImage: optional(source.INCUS_SANDBOX_COMPUTER_IMAGE),
    incusCpuLimit: optional(source.INCUS_SANDBOX_CPU_LIMIT),
    incusMemoryLimit: optional(source.INCUS_SANDBOX_MEMORY_LIMIT),
    incusProcessLimit: optional(source.INCUS_SANDBOX_PROCESS_LIMIT),
    localVmCli: optional(source.LOCAL_VM_CLI),
    localVmComputerImage: optional(source.LOCAL_VM_COMPUTER_IMAGE),
    localVmCpus: optional(source.LOCAL_VM_CPUS),
    localVmMemory: optional(source.LOCAL_VM_MEMORY),
    wuyingAccessKeyId: optional(source.WUYING_ACCESS_KEY_ID),
    wuyingAccessKeySecret: optional(source.WUYING_ACCESS_KEY_SECRET),
    wuyingRegionId: optional(source.WUYING_REGION_ID),
    wuyingDesktopId: optional(source.WUYING_DESKTOP_ID),
    wuyingEndUserId: optional(source.WUYING_END_USER_ID),
    wuyingMcpUrl: optional(source.WUYING_MCP_URL),
    wuyingMcpToken: optional(source.WUYING_MCP_TOKEN),
  };
}

function stringMap(value: string | undefined, name: string): Record<string, string> | undefined {
  const configured = optional(value);
  if (!configured) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(configured);
  } catch (error) {
    throw new Error(`${name} must be a JSON object of string values`, { cause: error });
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.values(parsed).some((entry) => typeof entry !== "string")
  ) {
    throw new Error(`${name} must be a JSON object of string values`);
  }
  return parsed as Record<string, string>;
}

function positiveInteger(value: string | undefined, name: string): number | undefined {
  const configured = optional(value);
  if (!configured) return undefined;
  const parsed = Number(configured);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

/** PEM text, with `\n` escapes allowed so it fits on one line of an env file. */
function pem(value: string | undefined): string | undefined {
  return optional(value)?.replace(/\\n/g, "\n");
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

export function boatApiKeyFromEnv(source: NodeJS.ProcessEnv): string | undefined {
  return optional(source.BOAT_API_KEY);
}

export function boatApiUrlFromEnv(source: NodeJS.ProcessEnv): string | undefined {
  return optional(source.BOAT_API_URL);
}
