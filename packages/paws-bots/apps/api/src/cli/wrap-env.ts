// `printf %s "$VALUE" | node dist/cli/wrap-env.js NAME` prints NAME's value wrapped by the
// configured key manager. The value comes from stdin so it never lands in argv or history.
import { text } from "node:stream/consumers";
import { KEY_PROVIDER_SETTINGS, keyManagerFromEnv, wrapEnvValue } from "@rakazo/adapters";
import { loadRootEnv } from "@rakazo/core/node/load-root-env";

loadRootEnv();
const [name, ...rest] = process.argv.slice(2);
if (!name || rest.length || !/^[A-Z][A-Z0-9_]*$/.test(name))
  throw new Error("Usage: wrap-env NAME < value");
if (KEY_PROVIDER_SETTINGS.includes(name))
  throw new Error(`Key manager settings cannot be wrapped: ${name}`);
const provider = keyManagerFromEnv();
if (!provider) throw new Error("Set MASTER_KEY_PROVIDER to a key manager to wrap values");
const value = (await text(process.stdin)).replace(/\r?\n$/, "");
if (!value) throw new Error(`No value for ${name} on stdin`);
process.stdout.write(`${await wrapEnvValue(provider, name, value)}\n`);
