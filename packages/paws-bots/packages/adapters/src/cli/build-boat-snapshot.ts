import { BoatSandboxProvider } from "../boat-sandbox.js";

const apiKey = process.env.BOAT_API_KEY?.trim();
if (!apiKey) {
  process.stderr.write("Set BOAT_API_KEY to the Boat key this deployment uses.\n");
  process.exit(1);
}

const apiUrl = process.env.BOAT_API_URL?.trim();
const provider = new BoatSandboxProvider({ apiKey, ...(apiUrl ? { apiUrl } : {}) });
const { name, built } = await provider.buildComputerSnapshot();
process.stdout.write(
  built ? `Built Boat snapshot ${name}.\n` : `Boat snapshot ${name} is already ready.\n`,
);
