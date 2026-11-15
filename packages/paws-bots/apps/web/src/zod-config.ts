import { config } from "zod";

// Zod probes `new Function` to compile faster parsers. The app's CSP blocks eval, so every
// page load filed a violation report even though Zod catches the failure.
config({ jitless: true });
