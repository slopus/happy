import { createBoxdSandboxProvider } from "../boxd-sandbox.js";

const apiKey = process.env.BOXD_API_KEY?.trim();
if (!apiKey) {
  process.stderr.write("Set BOXD_API_KEY to the boxd key this deployment uses.\n");
  process.exit(1);
}

const org = process.env.BOXD_ORG?.trim();
const provider = await createBoxdSandboxProvider({ apiKey, ...(org ? { org } : {}) });
const { name, built } = await provider.buildComputerSnapshot();
process.stdout.write(
  built ? `Built boxd snapshot ${name}.\n` : `boxd snapshot ${name} is already ready.\n`,
);
