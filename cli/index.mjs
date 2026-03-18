import { sync } from './commands/sync.mjs';
import { restack } from './commands/restack.mjs';
import { submit } from './commands/submit.mjs';
import { move } from './commands/move.mjs';
import { track, untrack } from './commands/track.mjs';
import { create } from './commands/create.mjs';
import { log } from './commands/log.mjs';
import { up, down } from './commands/navigate.mjs';

const COMMANDS = { sync, restack, submit, move, track, untrack, create, log, up, down };

const HELP = `\x1b[1mstaqd\x1b[0m — Stacked PR CLI

\x1b[1mUSAGE\x1b[0m
  st <command> [options]

\x1b[1mCOMMANDS\x1b[0m
  sync       Sync local branches with remote (after Actions restack)
  restack    Locally rebase stack branches onto their parents
  submit     Push branches and create/update PRs
  move       Move current branch to a new parent
  track      Register current branch in the stack (--parent, --list)
  untrack    Remove current branch from the stack
  create     Create a new branch and auto-track it
  log        Visualize the tracked stack tree
  up         Move to child branch in the stack
  down       Move to parent branch in the stack

\x1b[1mOPTIONS\x1b[0m
  --help     Show help
  --dry-run  Show what would be done without making changes`;

export async function run(args) {
  const command = args[0];

  if (!command || command === '--help' || command === 'help') {
    console.log(HELP);
    return;
  }

  const handler = COMMANDS[command];
  if (!handler) {
    console.error(`Unknown command: ${command}\n`);
    console.log(HELP);
    process.exit(1);
  }

  const flags = parseFlags(args.slice(1));
  await handler(flags);
}

function parseFlags(args) {
  const flags = { _: [] };
  for (const arg of args) {
    if (arg.startsWith('--')) {
      const [key, val] = arg.slice(2).split('=');
      flags[key] = val ?? true;
    } else {
      flags._.push(arg);
    }
  }
  return flags;
}
// feature C
