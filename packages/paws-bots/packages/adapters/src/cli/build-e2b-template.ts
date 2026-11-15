import { buildE2BComputerTemplate } from "../e2b-template.js";

const apiKey = process.env.E2B_API_KEY?.trim();
if (!apiKey) {
  process.stderr.write("Set E2B_API_KEY to the E2B key this deployment uses.\n");
  process.exit(1);
}

const built = await buildE2BComputerTemplate(apiKey, {
  onBuildLogs: (line) => process.stdout.write(`${line}\n`),
});
process.stdout.write(
  `Built E2B template ${built.name}. New computers use it from their next start.\n`,
);
