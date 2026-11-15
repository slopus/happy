import { createHash } from "node:crypto";

const {
  RAILWAY_API_TOKEN: token,
  RAILWAY_PROJECT_ID: projectId,
  RAILWAY_SERVICE_ID: serviceId,
  RAILWAY_ENVIRONMENT_ID: currentEnvironmentId,
} = process.env;
if (!token || !projectId || !serviceId || !currentEnvironmentId)
  throw new Error("Railway token, project, service and environment are required");

async function query(document, variables) {
  const response = await fetch("https://backboard.railway.com/graphql/v2", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: document, variables }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Railway environment setup failed (${response.status})`);
  const result = await response.json();
  if (result.errors?.length || !result.data) throw new Error("Railway environment setup failed");
  return result.data;
}

const name = `sbx-${createHash("sha256")
  .update(`${serviceId}:${currentEnvironmentId}`)
  .digest("hex")
  .slice(0, 24)}`;
const { project } = await query(
  "query($id: String!) { project(id: $id) { environments { edges { node { id name } } } } }",
  { id: projectId },
);
let environment = project.environments.edges.find(({ node }) => node.name === name)?.node;
if (!environment) {
  const result = await query(
    "mutation($input: EnvironmentCreateInput!) { environmentCreate(input: $input) { id } }",
    { input: { projectId, name } },
  );
  environment = result.environmentCreate;
}
if (!environment?.id || environment.id === currentEnvironmentId) {
  throw new Error("Sandbox environment must be separate from the application");
}
process.stdout.write(environment.id);
