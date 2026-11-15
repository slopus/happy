import { defineApiComputerProvider } from "./computer-provider-descriptor.js";

export const novitaComputerSettings = defineApiComputerProvider("novita", "Novita", [
  ["apiKey", "NOVITA_API_KEY", "API key", "secret", true],
  ["template", "SANDBOX_TEMPLATE", "Template", "text", false],
]);
