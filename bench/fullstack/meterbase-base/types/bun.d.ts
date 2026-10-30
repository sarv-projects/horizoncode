/**
 * Minimal ambient declarations for the Bun runtime.
 *
 * This repo has no installed dependencies, so `bun-types` is unavailable. This file
 * exists only so `tsc --noEmit` can type-check the skeleton without an install. It is
 * deliberately small: it covers the Bun and node: built-ins the scaffold uses.
 *
 * If `bun-types` becomes available, delete this file and set
 * `"types": ["bun-types"]` in tsconfig.json. If you need another Bun API before
 * then, add an accurate signature here rather than reaching for `any` at the call
 * site.
 */

declare var process: {
  readonly env: Record<string, string | undefined>;
  readonly argv: string[];
  readonly execPath: string;
  readonly pid: number;
  readonly platform: string;
  cwd(): string;
  exit(code?: number): never;
  on(event: string, listener: (...args: any[]) => void): void;
};

interface ImportMeta {
  readonly main: boolean;
  readonly dir: string;
  readonly file: string;
  readonly path: string;
}

interface BunServeOptions {
  port?: number | string;
  hostname?: string;
  unix?: string;
  development?: boolean;
  idleTimeout?: number;
  maxRequestBodySize?: number;
  error?: (error: Error) => Response | Promise<Response> | undefined;
  fetch: (request: Request, server: BunHttpServer) => Response | Promise<Response> | undefined;
}

interface BunHttpServer {
  readonly port: number;
  readonly hostname: string;
  readonly url: URL;
  readonly pendingRequests: number;
  readonly pendingWebSockets: number;
  fetch(request: Request): Response | Promise<Response>;
  stop(closeActiveConnections?: boolean): Promise<void>;
  reload(options?: unknown): Promise<void>;
  ref(): void;
  unref(): void;
}

interface BunSpawnOptions {
  cmd?: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdin?: 'pipe' | 'inherit' | 'ignore' | number;
  stdout?: 'pipe' | 'inherit' | 'ignore' | number;
  stderr?: 'pipe' | 'inherit' | 'ignore' | number;
  windowsHide?: boolean;
}

interface BunSubprocess {
  readonly pid: number;
  readonly exitCode: number | null;
  readonly signalCode: number | null;
  readonly killed: boolean;
  readonly stdout: ReadableStream<Uint8Array> | null;
  readonly stderr: ReadableStream<Uint8Array> | null;
  readonly stdin: unknown;
  readonly exited: Promise<number>;
  kill(signal?: string): void;
  ref(): void;
  unref(): void;
}

interface BunSyncResult {
  readonly exitCode: number;
  readonly success: boolean;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
}

interface BunFile extends Blob {
  readonly name: string;
  readonly size: number;
  text(encoding?: string): Promise<string>;
  json(): Promise<any>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

declare var Bun: {
  serve(options: BunServeOptions): BunHttpServer;
  spawn(options: BunSpawnOptions): BunSubprocess;
  spawn(cmd: string[], options?: BunSpawnOptions): BunSubprocess;
  spawnSync(options: BunSpawnOptions): BunSyncResult;
  spawnSync(cmd: string[], options?: BunSpawnOptions): BunSyncResult;
  file(path: string): BunFile;
  write(path: string, data: string | Uint8Array | Blob): Promise<number>;
  sleep(ms: number): Promise<void>;
  readonly env: Record<string, string | undefined>;
  readonly version: string;
  gc(force?: boolean): void;
};

declare module 'bun:sqlite' {
  export interface Statement {
    all(...params: any[]): unknown[];
    get(...params: any[]): unknown;
    run(...params: any[]): { changes: number; lastInsertRowid: number | bigint };
    values(...params: any[]): unknown[][];
    columnNames(): string[];
    finalize(): void;
    readonly native: unknown;
  }

  export interface DatabaseOptions {
    create?: boolean;
    readonly?: boolean;
    readwrite?: boolean;
    safeIntegers?: boolean;
    strict?: boolean;
  }

  export class Database {
    constructor(filename?: string, options?: DatabaseOptions);
    query(sql: string): Statement;
    prepare(sql: string): Statement;
    run(sql: string, ...params: any[]): { changes: number; lastInsertRowid: number | bigint };
    exec(sql: string): void;
    transaction<A extends any[], R>(fn: (...args: A) => R): (...args: A) => R;
    close(throwOnError?: boolean): void;
    serialize(): Uint8Array;
    loadExtension(path: string): void;
    readonly filename: string;
    readonly inTransaction: boolean;
  }
}

declare module 'bun:test' {
  export interface Matchers<T = unknown> {
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toStrictEqual(expected: unknown): void;
    toContain(expected: unknown): void;
    toContainEqual(expected: unknown): void;
    toMatch(expected: RegExp | string): void;
    toHaveProperty(path: string, value?: unknown): void;
    toHaveLength(length: number): void;
    toBeGreaterThan(value: number): void;
    toBeGreaterThanOrEqual(value: number): void;
    toBeLessThan(value: number): void;
    toBeLessThanOrEqual(value: number): void;
    toBeTruthy(): void;
    toBeFalsy(): void;
    toBeNull(): void;
    toBeUndefined(): void;
    toBeDefined(): void;
    toBeInstanceOf(ctor: Function): void;
    toThrow(message?: string | RegExp): void;
    not: Matchers<T>;
    resolves: Matchers<unknown>;
    rejects: Matchers<unknown>;
  }

  export function describe(name: string, fn: () => void | Promise<void>): void;
  export function test(name: string, fn: () => void | Promise<void>, timeout?: number): void;
  export function it(name: string, fn: () => void | Promise<void>, timeout?: number): void;
  export function beforeAll(fn: () => void | Promise<void>, timeout?: number): void;
  export function afterAll(fn: () => void | Promise<void>, timeout?: number): void;
  export function beforeEach(fn: () => void | Promise<void>, timeout?: number): void;
  export function afterEach(fn: () => void | Promise<void>, timeout?: number): void;
  export function expect<T = unknown>(value: T): Matchers<T>;
  export function setDefaultTimeout(ms: number): void;
}

declare module 'node:fs' {
  export function mkdirSync(path: string, options?: { recursive?: boolean; mode?: number }): string | undefined;
  export function existsSync(path: string): boolean;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function writeFileSync(path: string, data: string, encoding?: 'utf8'): void;
  export function unlinkSync(path: string): void;
  export function mkdtempSync(prefix: string, options?: { encoding?: 'utf8' }): string;
  export function statSync(path: string): { isDirectory(): boolean; isFile(): boolean; size: number };
}

declare module 'node:path' {
  export function join(...parts: string[]): string;
  export function resolve(...parts: string[]): string;
  export function dirname(path: string): string;
  export function basename(path: string, ext?: string): string;
  export function extname(path: string): string;
}

declare module 'node:os' {
  export function tmpdir(): string;
  export function homedir(): string;
}

declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string;
  export function pathToFileURL(path: string): URL;
}

declare module 'node:crypto' {
  export function randomUUID(): string;
  export function createHash(algorithm: string): {
    update(data: string | Uint8Array): unknown;
    digest(encoding: 'hex'): string;
  };
  export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
}
