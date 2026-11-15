import { defineApiComputerProvider } from "./computer-provider-descriptor.js";

export const railwayComputerSettings = defineApiComputerProvider("railway", "Railway", [
  ["apiToken", "RAILWAY_API_TOKEN", "API token", "secret", true],
  ["environmentId", "RAILWAY_ENVIRONMENT_ID", "Environment ID", "text", true],
  ["region", "RAILWAY_SANDBOX_REGION", "Region", "text", false],
]);
