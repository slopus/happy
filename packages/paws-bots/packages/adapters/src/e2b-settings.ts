import { defineApiComputerProvider } from "./computer-provider-descriptor.js";

export const e2bComputerSettings = defineApiComputerProvider("e2b", "E2B", [
  ["apiKey", "E2B_API_KEY", "API key", "secret", true],
]);
