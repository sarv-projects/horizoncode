/**
 * Black-box test harness for the Meterbase service.
 *
 * Every test talks HTTP to a real `bun run src/index.ts` process on a random free
 * port, against a freshly seeded temp `DATA_DIR`. Nothing is imported from `src/`,
 * so the suite is indifferent to how the implementation is structured.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root (the directory containing package.json and TASK.md). */
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Seeded credentials — see TASK.md "## Fixtures". */
export const SEEDED_KEY = 'mb_test_demo_key';
export const SEEDED_JPY_KEY = 'mb_test_jpy_key';
export const WEBHOOK_SECRET = 'whsec_smoke_secret';

const READY_TIMEOUT_MS = 20_000;

export interface ServerHandle {
  readonly port: number;
  readonly baseUrl: string;
  readonly dataDir: string;
  /** Absolute URL for a path such as `/v1/invoices?limit=1`. */
  url(path: string): string;
  request(path: string, init?: RequestInit): Promise<Response>;
  /** Seed output plus everything the child process wrote to stdout/stderr. */
  logs(): string;
  stop(): Promise<void>;
}

export const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Reserve an ephemeral port by binding port 0, then releasing it. */
export async function freePort(): Promise<number> {
  const probe = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: () => new Response('probe'),
  });
  const port = probe.port;
  await probe.stop(true);
  return port;
}

/** Run `bun run seed` against `dataDir`; throws with captured output on failure. */
export function runSeed(dataDir: string): string {
  const result = Bun.spawnSync({
    cmd: [process.execPath, 'run', join(ROOT, 'src/seed.ts')],
    cwd: ROOT,
    env: { ...process.env, DATA_DIR: dataDir },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);
  if (result.exitCode !== 0) {
    throw new Error(
      `seed failed (exit ${result.exitCode}) with DATA_DIR=${dataDir}\n${stdout}\n${stderr}`,
    );
  }
  return stdout.trim();
}

async function capture(stream: ReadableStream<Uint8Array> | null, sink: string[]): Promise<void> {
  if (!stream) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) sink.push(decoder.decode(value, { stream: true }));
    }
  } catch {
    // The stream is torn down with the child process; nothing useful to add.
  }
}

/**
 * Seed a temp data dir, boot the server on a random free port, and resolve once it
 * answers HTTP (any status counts — the skeleton answers 501).
 */
export async function startServer(
  options: { dataDir?: string; port?: number; env?: Record<string, string> } = {},
): Promise<ServerHandle> {
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), 'meterbase-smoke-'));
  const seedOutput = runSeed(dataDir);
  const port = options.port ?? (await freePort());
  const baseUrl = `http://127.0.0.1:${port}`;
  const logs: string[] = [`seed: ${seedOutput}\n`];

  const child = Bun.spawn({
    cmd: [process.execPath, 'run', join(ROOT, 'src/index.ts')],
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      WEBHOOK_SECRET,
      WEBHOOK_TOLERANCE_SECONDS: '300',
      RATE_LIMIT_PER_MINUTE: '1000',
      NODE_ENV: 'test',
      ...options.env,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const pumps = [capture(child.stdout, logs), capture(child.stderr, logs)];
  const url = (path: string): string => `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;

  const handle: ServerHandle = {
    port,
    baseUrl,
    dataDir,
    url,
    request: (path, init) => fetch(url(path), init),
    logs: () => logs.join(''),
    stop: async () => {
      try {
        child.kill();
      } catch {
        // Already exited.
      }
      await Promise.race([child.exited, sleep(5_000)]);
      await Promise.race([Promise.all(pumps), sleep(2_000)]);
      rmSync(dataDir, { recursive: true, force: true });
    },
  };

  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastError = 'no response yet';
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      await Promise.race([Promise.all(pumps), sleep(2_000)]);
      throw new Error(
        `server exited with code ${child.exitCode} before becoming ready on ${baseUrl}\n${handle.logs()}`,
      );
    }
    try {
      const probe = await fetch(url('/__ready__'));
      await probe.arrayBuffer();
      return handle;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await sleep(50);
    }
  }

  await handle.stop();
  throw new Error(
    `server was not ready on ${baseUrl} within ${READY_TIMEOUT_MS}ms (${lastError})\n${handle.logs()}`,
  );
}

/** Authorization header for a seeded account. */
export function auth(
  apiKey: string = SEEDED_KEY,
  extra: Record<string, string> = {},
): Record<string, string> {
  return { authorization: `Bearer ${apiKey}`, ...extra };
}

/** POST a JSON body with optional extra headers. */
export function postJson(
  handle: ServerHandle,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return handle.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}
