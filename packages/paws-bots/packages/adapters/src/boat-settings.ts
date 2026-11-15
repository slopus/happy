import { defineApiComputerProvider } from "./computer-provider-descriptor.js";

export const boatComputerSettings = defineApiComputerProvider("boat", "Boat", [
  ["apiKey", "BOAT_API_KEY", "API key", "secret", true],
  ["apiUrl", "BOAT_API_URL", "API URL", "url", false],
]);
