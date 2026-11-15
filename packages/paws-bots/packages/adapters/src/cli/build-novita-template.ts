import { buildNovitaComputerTemplate } from "../novita-template.js";

const apiKey = process.env.NOVITA_API_KEY?.trim();
if (!apiKey) {
  process.stderr.write("Set NOVITA_API_KEY to the Novita key this deployment uses.\n");
  process.exit(1);
}

const built = await buildNovitaComputerTemplate(apiKey, {
  template: process.env.SANDBOX_TEMPLATE,
  onBuildLogs: (line) => process.stdout.write(`${line}\n`),
});
process.stdout.write(
  `Built Novita template ${built.name}. New computers use it from their next start.\n`,
);
