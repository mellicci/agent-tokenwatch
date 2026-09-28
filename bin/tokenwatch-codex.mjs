#!/usr/bin/env node
import { runCodexWrapper } from '../src/codex-wrapper.mjs';

runCodexWrapper(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (error) => {
    console.error(`tokenwatch-codex: ${error?.message ?? String(error)}`);
    if (process.env.TOKENWATCH_DEBUG === '1' && error?.stack) console.error(error.stack);
    process.exitCode = 1;
  },
);
