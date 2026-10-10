#!/usr/bin/env node
/**
 * Operator CLI for reviewing community-signal candidates.
 *
 * Calls the internal API with the same HMAC + per-token-secret authentication the
 * Worker enforces (internal + admin scopes). All credentials come from environment
 * variables; nothing is written to disk or printed.
 */
import { parseArgs } from 'node:util';
import {
  ENV_VARS,
  UsageError,
  ReviewApiError,
  parseConfig,
  listCandidates,
  approveSignal,
  rejectSignal,
  formatCandidates,
  sanitizeForTerminal,
} from './signal-review/client.mjs';

const USAGE = `Usage:
  node scripts/signal-review.mjs list <event-hash> [--limit N] [--json]
  node scripts/signal-review.mjs approve <event-hash> <signal-id>
  node scripts/signal-review.mjs reject <event-hash> <signal-id> --reason "<why>"

Required environment variables:
  ${ENV_VARS.apiUrl}       Worker origin, e.g. https://api.example.com (https only, except localhost)
  ${ENV_VARS.hmacSecret}                 The Worker's HMAC signing secret
  ${ENV_VARS.tokenId}      pipeline_tokens.token_id of a token with scopes internal,admin
  ${ENV_VARS.tokenSecret}  That token's secret (its SHA-256 is stored, never the secret)
  ${ENV_VARS.reviewerId}   Your reviewer identity, recorded as reviewer_id. Must exactly match
                              the name of your own token, or reviews are refused (HTTP 403)

Exit codes: 0 success, 1 API or network error, 2 usage or configuration error.`;

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      limit: { type: 'string' },
      reason: { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  const [command, eventHash, signalId] = positionals;
  if (values.help || !command) {
    console.log(USAGE);
    return values.help ? 0 : 2;
  }

  const expectedArgs = { list: 2, approve: 3, reject: 3 }[command];
  if (expectedArgs === undefined) throw new UsageError(`Unknown command: ${command}`);
  if (positionals.length !== expectedArgs) throw new UsageError(`Wrong number of arguments for "${command}"`);

  const config = parseConfig(process.env);

  if (command === 'list') {
    const data = await listCandidates(config, eventHash, { limit: values.limit });
    console.log(values.json ? JSON.stringify(data, null, 2) : formatCandidates(data));
  } else if (command === 'approve') {
    await approveSignal(config, eventHash, signalId);
    console.log(`Approved signal ${signalId} for event ${eventHash}.`);
  } else {
    await rejectSignal(config, eventHash, signalId, values.reason);
    console.log(`Rejected signal ${signalId} for event ${eventHash}.`);
  }
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    if (err instanceof ReviewApiError) {
      const status = err.status ? `HTTP ${err.status}` : 'network error';
      console.error(`Error (${status}): ${err.message}`);
      process.exitCode = 1;
    } else if (err instanceof UsageError || (err && err.code && String(err.code).startsWith('ERR_PARSE_ARGS'))) {
      console.error(`Error: ${sanitizeForTerminal(err.message)}\n\n${USAGE}`);
      process.exitCode = 2;
    } else {
      console.error('Unexpected error:', err instanceof Error ? err.message : 'unknown');
      process.exitCode = 1;
    }
  }
);
