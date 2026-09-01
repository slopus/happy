#!/usr/bin/env node

import { runCli } from '../dist/cli.mjs';

process.exitCode = await runCli();
