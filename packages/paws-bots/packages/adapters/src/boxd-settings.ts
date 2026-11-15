import { defineApiComputerProvider } from "./computer-provider-descriptor.js";

export const boxdComputerSettings = defineApiComputerProvider("boxd", "Boxd", [
  ["apiKey", "BOXD_API_KEY", "API key", "secret", true],
  ["org", "BOXD_ORG", "Organization", "text", false],
]);
