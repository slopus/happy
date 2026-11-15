import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderTokensCss } from "./index.js";

writeFileSync(fileURLToPath(new URL("./tokens.css", import.meta.url)), renderTokensCss());
