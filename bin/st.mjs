#!/usr/bin/env node

import { run } from '../cli/index.mjs';

run(process.argv.slice(2)).catch(err => {
  console.error(`\x1b[31merror:\x1b[0m ${err.message}`);
  process.exit(1);
});
