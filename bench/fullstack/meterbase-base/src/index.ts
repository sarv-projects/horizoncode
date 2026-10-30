/**
 * Meterbase — HTTP entrypoint (skeleton).
 *
 * Deliberately unimplemented: every route answers 501 with RFC 9457 problem
 * details so `bun run start` boots instantly and honestly. Implement the routes
 * described in TASK.md here (or in modules this file imports). The visible
 * acceptance suite in test/smoke.test.ts is red until then — do not change the
 * tests to make them green.
 */
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Error `type` base for this service; every problem response uses a URI under it. */
export const ERROR_BASE = 'https://errors.meterbase.dev/';

/** Persistence root: `DATA_DIR` (default `./.data`), created on boot. */
export const DATA_DIR = resolve(process.env.DATA_DIR ?? './.data');

/** SQLite file produced by `bun run seed` (see docs/SCHEMA.md). */
export const DB_PATH = join(DATA_DIR, 'meterbase.db');

mkdirSync(DATA_DIR, { recursive: true });

function configuredPort(): number {
  const raw = process.env.PORT;
  const parsed = raw === undefined || raw === '' ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 8787;
}

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
}

/** Problem details for a route that has no implementation yet. */
export function notImplemented(method: string, instance: string): Response {
  const body: ProblemDetails = {
    type: `${ERROR_BASE}not-implemented`,
    title: 'Not implemented',
    status: 501,
    detail: `No handler for ${method} ${instance} yet; see TASK.md for the required behaviour.`,
    instance,
  };
  return new Response(JSON.stringify(body), {
    status: 501,
    headers: {
      'content-type': 'application/problem+json',
      'cache-control': 'no-store',
    },
  });
}

export const server = Bun.serve({
  port: configuredPort(),
  fetch(request) {
    const { pathname } = new URL(request.url);
    return notImplemented(request.method, pathname);
  },
});

console.log(
  `meterbase: skeleton on http://${server.hostname}:${server.port} (DATA_DIR=${DATA_DIR}, every route -> 501)`,
);

export default server;
