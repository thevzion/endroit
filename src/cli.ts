#!/usr/bin/env bun

import {
  checkWorkplaceMount,
  compileWorkplaceMount,
  readyWorkplace,
} from "./compiler/index.ts";
import { previewAdoption } from "./compiler/adoption.ts";
import {
  applyNewWorkplace,
  loadStandardProfile,
  planNewWorkplace,
  renderNewWorkplacePreview,
} from "./compiler/new-workplace.ts";
import { runNewWizard } from "./new-wizard.ts";
import { resolve } from "node:path";
import { checkGitHistory, checkGitStaged } from "./compiler/git-witness.ts";
import { deriveWorkplaceRegistry, enterWorkplace, FederationError } from "./federation.ts";

type Parsed = {
  values: Record<string, string>;
  flags: Set<string>;
  positionals: string[];
};

function parse(values: string[]): Parsed {
  const result: Parsed = { values: {}, flags: new Set(), positionals: [] };
  for (let index = 0; index < values.length; index++) {
    const value = values[index]!;
    if (!value.startsWith("--")) {
      result.positionals.push(value);
      continue;
    }
    const name = value.slice(2);
    const next = values[index + 1];
    if (!next || next.startsWith("--")) result.flags.add(name);
    else {
      result.values[name] = next;
      index++;
    }
  }
  return result;
}

function print(value: unknown, json: boolean): void {
  if (json) console.log(JSON.stringify(value, null, 2));
  else if (typeof value === "object" && value && "kind" in value && value.kind === "WorkplaceRegistry") {
    const registry = value as unknown as { anchor: string; entries: Array<{ workplace: string; provenance: string[]; availability: string; state: string }> };
    console.log([registry.anchor, ...registry.entries.map((entry) => `${entry.workplace} · ${entry.provenance.join("+")} · ${entry.availability} · ${entry.state}`)].join("\n"));
  }
  else if (typeof value === "object" && value && "kind" in value && value.kind === "EnteredWorkplace") {
    const entered = value as unknown as { workplace: string; member: string; desk: string; frontDoor: string };
    console.log(`${entered.workplace} · entered\n${entered.member}\n${entered.desk}\n${entered.frontDoor}`);
  }
  else if (typeof value === "object" && value && "kind" in value && value.kind === "NewWorkplaceResult") {
    const created = value as unknown as { mount: string; revision: string; check: { operationStatus: string } };
    console.log(`${created.check.operationStatus} · created\n${created.mount}\n${created.revision}`);
  }
  else if (typeof value === "object" && value && "check" in value) {
    const ready = value as { mount: string; changed: boolean; check: { entryStatus: string; operationStatus: string; requiredAction?: string } };
    console.log(`${ready.check.operationStatus} · ${ready.check.entryStatus} · ${ready.changed ? "rebuilt" : "unchanged"}\n${ready.mount}${ready.check.requiredAction ? `\n${ready.check.requiredAction}` : ""}`);
  } else {
    const result = value as { root?: string; outDir?: string; revision?: string; status?: string; entryStatus?: string; operationStatus?: string; requiredAction?: string };
    console.log([result.root ?? result.outDir, result.status ?? result.entryStatus ?? result.revision, result.operationStatus, result.requiredAction].filter(Boolean).join("\n"));
  }
}

const [command, ...rest] = Bun.argv.slice(2);
const options = parse(rest);

try {
  if (command === "new") {
    const requestPath = options.values.request;
    const wantsPreview = options.flags.has("preview");
    const applyRevision = options.values.apply;
    const json = options.flags.has("json");
    const profile = await loadStandardProfile(options.values.profile ?? resolve(import.meta.dir, "../profiles/standard/profile.json"));
    const cliCommand = [Bun.argv[0]!, resolve(Bun.argv[1]!)];
    if (requestPath) {
      if (wantsPreview === Boolean(applyRevision)) throw new Error("usage: endroit new --request <file> (--preview | --apply <sha256>) [--json]");
      const request = JSON.parse(await Bun.file(requestPath).text()) as unknown;
      const plan = planNewWorkplace(request, { profile, cliCommand });
      if (wantsPreview) {
        if (json) {
          const { contents: _contents, ...preview } = plan;
          console.log(JSON.stringify(preview, null, 2));
        } else console.log(renderNewWorkplacePreview(plan));
      } else {
        const result = await applyNewWorkplace(plan, applyRevision!);
        print(result, json);
      }
    } else {
      const target = options.positionals[0];
      if (!target) throw new Error("usage: endroit new <directory> (interactive TTY) or endroit new --request <file> --preview|--apply <sha256>");
      if (json || process.stdin.isTTY !== true || process.stdout.isTTY !== true) throw new Error("endroit new is non-interactive here; provide --request <file> with --preview or --apply <sha256>");
      const result = await runNewWizard({ target, profile, cliCommand, input: process.stdin, output: process.stdout, noColor: Boolean(process.env.NO_COLOR) });
      if (!result) process.exitCode = 130;
    }
  } else if (command === "workplace") {
    const action = options.positionals[0];
    if (action === "list") {
      const anchor = options.positionals[1] ?? options.values.anchor;
      if (!anchor) throw new Error("usage: endroit workplace list <anchor-mount> [--bindings <file>] [--json]");
      print(await deriveWorkplaceRegistry(anchor, options.values.bindings), options.flags.has("json"));
    } else if (action === "enter") {
      const target = options.positionals[1];
      const anchor = options.values.anchor;
      if (!target || !anchor) throw new Error("usage: endroit workplace enter <target-ref> --anchor <anchor-mount> [--bindings <file>] [--provider <id>] [--profile <file>] [--json]");
      print(await enterWorkplace({ anchorMount: anchor, target, ...(options.values.bindings ? { localPath: options.values.bindings } : {}), ...(options.values.provider ? { provider: options.values.provider } : {}), ...(options.values.profile ? { profilePath: resolve(options.values.profile) } : {}) }), options.flags.has("json"));
    } else throw new Error("usage: endroit workplace <list|enter> ...");
  } else if (command === "compile") {
    const mount = options.values.mount ?? options.values.root;
    if (!mount) throw new Error("usage: endroit compile --mount <path> [--entry <file>] [--provider <id>]");
    const result = await compileWorkplaceMount({ mount, ...(options.values.entry ? { entryPath: options.values.entry } : {}), ...(options.values.provider ? { provider: options.values.provider } : {}), ...(options.values.profile ? { profilePath: resolve(options.values.profile) } : {}) });
    print(result, options.flags.has("json"));
  } else if (command === "check") {
    const start = options.positionals[0] ?? options.values.mount ?? options.values.root;
    if (!start) throw new Error("usage: endroit check <path> [--staged [--commit-message <file>] | --history] [--provider <id>] [--json]");
    if (options.flags.has("staged") && options.flags.has("history")) throw new Error("check accepts either --staged or --history");
    const result = options.flags.has("staged")
      ? await checkGitStaged({ start, ...(options.values["commit-message"] ? { commitMessage: await Bun.file(options.values["commit-message"]).text() } : {}) })
      : options.flags.has("history")
        ? await checkGitHistory(start)
        : await checkWorkplaceMount({ mount: start, ...(options.values.provider ? { provider: options.values.provider } : {}), ...(options.values.profile ? { profilePath: resolve(options.values.profile) } : {}) });
    print(result, options.flags.has("json"));
    process.exitCode = "status" in result ? result.status === "valid" ? 0 : 1 : result.compileStatus === "valid" ? 0 : 1;
  } else if (command === "ready") {
    const result = await readyWorkplace({ start: options.positionals[0] ?? process.cwd(), ...(options.values.provider ? { provider: options.values.provider } : {}), ...(options.values.profile ? { profilePath: resolve(options.values.profile) } : {}) });
    print(result, options.flags.has("json"));
    process.exitCode = result.check.operationStatus === "ready" ? 0 : result.check.entryStatus === "onboarding-required" ? 3 : 1;
  } else if (command === "preview") {
    const source = options.positionals[0];
    const outDir = options.values.out;
    if (!source || !outDir) throw new Error("usage: endroit preview <source> --out <directory> [--ignore <file>] [--json]");
    const ignore = options.values.ignore ? await Bun.file(options.values.ignore).text() : undefined;
    const result = await previewAdoption({ source, outDir, ...(ignore !== undefined ? { ignore } : {}) });
    print(result, options.flags.has("json"));
  } else {
    throw new Error("usage: endroit <new|ready|compile|check|preview|workplace> ...");
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof FederationError ? error.code : undefined;
  console.error(options.flags.has("json") ? JSON.stringify({ ...(code ? { code } : {}), error: message }, null, 2) : message);
  process.exitCode = code && ["unavailable", "unsafe-mount", "identity-mismatch", "compile-required"].includes(code) ? 1 : 2;
}
