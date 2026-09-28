#!/usr/bin/env node
import { main } from '../src/cli.mjs';

main(process.argv.slice(2)).then((code) => {
  // The resolved value is the command's exit code. Discarding it meant
  // `tokenwatch doctor` always exited 0, so it reported problems in its output
  // while telling any script or health check that everything was fine.
  if (Number.isInteger(code) && code !== 0) process.exitCode = code;
}).catch((error) => {
  const debug = process.env.TOKENWATCH_DEBUG === '1';
  console.error(`tokenwatch: ${error?.message ?? String(error)}`);
  if (debug && error?.stack) console.error(error.stack);
  process.exitCode = 1;
});
