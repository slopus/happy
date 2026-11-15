import { defineApiComputerProvider } from "./computer-provider-descriptor.js";

export const createosComputerSettings = defineApiComputerProvider("createos", "CreateOS", [
  ["apiKey", "CREATEOS_SANDBOX_API_KEY", "API key", "secret", true],
  ["baseUrl", "CREATEOS_SANDBOX_BASE_URL", "API URL", "url", false],
  ["shape", "CREATEOS_SANDBOX_SHAPE", "Shape", "text", false],
  ["rootfs", "CREATEOS_SANDBOX_ROOTFS", "Root filesystem", "text", false],
]);
