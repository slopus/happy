import { defineApiComputerProvider } from "./computer-provider-descriptor.js";

export const daytonaComputerSettings = defineApiComputerProvider("daytona", "Daytona", [
  ["apiKey", "DAYTONA_API_KEY", "API key", "secret", true],
  ["apiUrl", "DAYTONA_API_URL", "API URL", "url", false],
  ["target", "DAYTONA_TARGET", "Target", "text", false],
]);
