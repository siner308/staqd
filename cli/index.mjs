import { sync, spec as syncSpec } from './commands/sync.mjs';
import { restack, spec as restackSpec } from './commands/restack.mjs';
import { submit, spec as submitSpec } from './commands/submit.mjs';
import { move, spec as moveSpec } from './commands/move.mjs';
import { track, untrack, trackSpec, untrackSpec } from './commands/track.mjs';
import { create, spec as createSpec } from './commands/create.mjs';
import { log, spec as logSpec } from './commands/log.mjs';
import { up, down, upSpec, downSpec } from './commands/navigate.mjs';

const COMMANDS = {
  sync:    { handler: sync,    spec: syncSpec },
  restack: { handler: restack, spec: restackSpec },
  submit:  { handler: submit,  spec: submitSpec },
  move:    { handler: move,    spec: moveSpec },
  track:   { handler: track,   spec: trackSpec },
  untrack: { handler: untrack, spec: untrackSpec },
  create:  { handler: create,  spec: createSpec },
  log:     { handler: log,     spec: logSpec },
  up:      { handler: up,      spec: upSpec },
  down:    { handler: down,    spec: downSpec },
};

export async function run(args) {
  const command = args[0];

  if (!command || command === '--help' || command === '-h' || command === 'help') {
    printGlobalHelp();
    return;
  }

  const entry = COMMANDS[command];
  if (!entry) {
    console.error(`Unknown command: ${command}\n`);
    printGlobalHelp();
    process.exit(1);
  }

  const rest = args.slice(1);
  if (rest.includes('--help') || rest.includes('-h')) {
    printCommandHelp(entry.spec);
    return;
  }

  const flags = parseFlags(rest);
  validateFlags(flags, entry.spec);
  await entry.handler(flags);
}

function parseFlags(args) {
  const flags = { _: [] };
  for (const arg of args) {
    if (arg.startsWith('--')) {
      const rest = arg.slice(2);
      const eq = rest.indexOf('=');
      if (eq === -1) {
        flags[rest] = true;
      } else {
        flags[rest.slice(0, eq)] = rest.slice(eq + 1);
      }
    } else {
      flags._.push(arg);
    }
  }
  return flags;
}

function validateFlags(flags, spec) {
  const allowed = new Set(Object.keys(spec.flags || {}));
  for (const key of Object.keys(flags)) {
    if (key === '_') continue;
    if (!allowed.has(key)) {
      const hint = suggest(key, [...allowed]);
      const suffix = hint ? ` (did you mean --${hint}?)` : '';
      throw new Error(
        `Unknown flag --${key} for "${spec.name}"${suffix}\n` +
        `Run: st ${spec.name} --help`
      );
    }
    const def = spec.flags[key];
    if (def.requiresValue && flags[key] === true) {
      throw new Error(`--${key} requires a value (use --${key}=<value>)`);
    }
  }
}

// Levenshtein-free cheap heuristic: suggest the allowed flag with the longest
// common prefix with the unknown key.
function suggest(unknown, allowed) {
  let best = null;
  let bestLen = 0;
  for (const a of allowed) {
    let i = 0;
    while (i < unknown.length && i < a.length && unknown[i] === a[i]) i++;
    if (i > bestLen && i >= 2) { best = a; bestLen = i; }
  }
  return best;
}

function printGlobalHelp() {
  const lines = [
    '\x1b[1mstaqd\x1b[0m — Stacked PR CLI',
    '',
    '\x1b[1mUSAGE\x1b[0m',
    '  st <command> [options]',
    '  st <command> --help',
    '',
    '\x1b[1mCOMMANDS\x1b[0m',
  ];
  const width = Math.max(...Object.keys(COMMANDS).map(n => n.length));
  for (const name of Object.keys(COMMANDS)) {
    const { spec } = COMMANDS[name];
    lines.push(`  ${name.padEnd(width)}  ${spec.summary}`);
  }
  lines.push('');
  lines.push('\x1b[1mGLOBAL OPTIONS\x1b[0m');
  lines.push('  --help, -h  Show help (global or per-command)');
  console.log(lines.join('\n'));
}

function printCommandHelp(spec) {
  const lines = [
    `\x1b[1mst ${spec.name}\x1b[0m — ${spec.summary}`,
    '',
    '\x1b[1mUSAGE\x1b[0m',
    `  ${spec.usage}`,
  ];
  const flagNames = Object.keys(spec.flags || {});
  if (flagNames.length) {
    lines.push('');
    lines.push('\x1b[1mFLAGS\x1b[0m');
    const width = Math.max(...flagNames.map(n => n.length + (spec.flags[n].requiresValue ? 8 : 0)));
    for (const name of flagNames) {
      const def = spec.flags[name];
      const label = def.requiresValue ? `--${name}=<value>` : `--${name}`;
      lines.push(`  ${label.padEnd(width + 2)}  ${def.description}`);
    }
  }
  console.log(lines.join('\n'));
}
