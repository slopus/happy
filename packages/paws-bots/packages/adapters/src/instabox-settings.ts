import { defineApiComputerProvider } from "./computer-provider-descriptor.js";

export const instaboxComputerSettings = defineApiComputerProvider("instabox", "InstaBox", [
  ["apiKey", "INSTABOX_API_KEY", "API key", "secret", true],
]);
