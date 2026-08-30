interface ImportMeta {
  readonly dir: string;
}

declare const process: {
  exitCode?: number;
  readonly pid: number;
  readonly platform: string;
  readonly env: Record<string, string | undefined>;
  readonly stdin: import("node:stream").Readable & { isTTY?: boolean };
  readonly stdout: import("node:stream").Writable & { columns?: number; isTTY?: boolean };
  readonly stderr: import("node:stream").Writable & { columns?: number; isTTY?: boolean };
  cwd(): string;
  exit(code?: number): never;
};

declare namespace Bun {
  const argv: string[];

  class CryptoHasher {
    constructor(algorithm: "sha256");
    update(value: string | Uint8Array): this;
    digest(encoding: "hex"): string;
  }

  type BunFile = {
    text(): Promise<string>;
    json(): Promise<unknown>;
    exists(): Promise<boolean>;
  };

  function file(path: string | URL): BunFile;

  function spawnSync(command: string[], options: {
    cwd: string;
    env?: Record<string, string | undefined>;
    stdin?: string | Uint8Array;
    stdout: "pipe";
    stderr: "pipe";
  }): {
    exitCode: number;
    stdout: Uint8Array;
    stderr: Uint8Array;
  };

  function spawn(command: string[], options: {
    cwd: string;
    env?: Record<string, string | undefined>;
    stdout: "pipe";
    stderr: "pipe";
  }): {
    exited: Promise<number>;
    stdout: ReadableStream<Uint8Array>;
    stderr: ReadableStream<Uint8Array>;
    kill(): void;
  };
}

declare module "node:fs/promises" {
  export type Dirent = {
    name: string;
    isDirectory(): boolean;
    isFile(): boolean;
    isSymbolicLink(): boolean;
  };

  export function cp(source: string, destination: string, options: { recursive: boolean }): Promise<void>;
  export function chmod(path: string, mode: number): Promise<void>;
  export function lstat(path: string): Promise<{ mode: number; size: number; isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }>;
  export function mkdtemp(prefix: string): Promise<string>;
  export function mkdir(path: string, options: { recursive: boolean }): Promise<string | undefined>;
  export function readFile(path: string, encoding: "utf8"): Promise<string>;
  export function readFile(path: string): Promise<Uint8Array>;
  export function readlink(path: string): Promise<string>;
  export function realpath(path: string): Promise<string>;
  export function readdir(path: string, options: { withFileTypes: true }): Promise<Dirent[]>;
  export function rename(from: string, to: string): Promise<void>;
  export function rm(path: string, options: { recursive: boolean; force: boolean }): Promise<void>;
  export function stat(path: string): Promise<{ size: number; mode: number; isFile(): boolean }>;
  export function symlink(target: string, path: string, type?: "dir" | "file" | "junction"): Promise<void>;
  export function writeFile(path: string, data: string, options?: { flag: "wx" }): Promise<void>;
  export function writeFile(path: string, data: Uint8Array, options?: { flag: "wx" }): Promise<void>;
}

declare module "node:stream" {
  export type Readable = object;
  export type Writable = object;
  export class PassThrough {
    write(value: string): boolean;
  }
}

declare module "node:readline" {
  export type Key = { name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean; sequence?: string };
}

declare module "node:child_process" {
  export function spawnSync(command: string, args: string[], options: {
    cwd: string;
    input?: string | Uint8Array;
    env?: Record<string, string | undefined>;
    maxBuffer?: number;
  }): { status: number | null; stdout: Uint8Array; stderr: Uint8Array };
}

declare module "node:path" {
  export const sep: string;
  export function basename(path: string): string;
  export function dirname(path: string): string;
  export function join(...paths: string[]): string;
  export function relative(from: string, to: string): string;
  export function resolve(...paths: string[]): string;
}

declare module "node:os" {
  export function homedir(): string;
  export function tmpdir(): string;
}

declare module "bun:test" {
  type Matchers = {
    not: Matchers;
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toContain(expected: unknown): void;
    toHaveLength(expected: number): void;
    toThrow(expected?: string): void;
  };
  export function describe(name: string, run: () => void): void;
  export function test(name: string, run: () => void | Promise<void>): void;
  export function expect(value: unknown): Matchers;
}
