import { connectMcp } from "./connect-mcp.js";
import type { Flow } from "./flow.js";
import { weeklyShopping } from "./weekly-shopping.js";

export const FLOWS: Flow<any>[] = [weeklyShopping, connectMcp];
