import {
  cancel,
  confirm,
  group,
  intro,
  isCancel,
  multiselect,
  note,
  outro,
  select,
  tasks,
  text,
  unicode,
} from "@clack/prompts";
import type { LoadedProfilePackage } from "./compiler/model.ts";
import {
  applyNewWorkplace,
  assertNewWorkplaceTargetAvailable,
  planNewWorkplace,
  renderNewWorkplacePreview,
  slugify,
  type NewProvider,
  type NewWorkplaceResult,
} from "./compiler/new-workplace.ts";

type Input = Parameters<typeof text>[0]["input"];
type Output = Parameters<typeof text>[0]["output"] & { columns?: number; isTTY?: boolean };

export type NewWizardOptions = {
  target: string;
  profile: LoadedProfilePackage;
  cliCommand: string[];
  input?: Input;
  output?: Output;
  gitAuthor?: { name?: string; email?: string };
  noColor?: boolean;
};

export function renderWordmark(options: { tty: boolean; columns?: number; unicode?: boolean }): string {
  if (!options.tty) return "";
  return options.unicode !== false && (options.columns ?? 80) >= 42
    ? "┌─┐  ENDROIT\n└─┘  intent → path → outcome"
    : "ENDROIT — intent → path → outcome";
}

function common(options: NewWizardOptions) {
  return { ...(options.input ? { input: options.input } : {}), ...(options.output ? { output: options.output } : {}) };
}

function required(value: string | undefined): string | undefined {
  return value?.trim() ? undefined : "Required";
}

function slugValidation(value: string | undefined): string | undefined {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value ?? "") ? undefined : "Use lowercase letters, digits and hyphens";
}

function languageValidation(value: string | undefined): string | undefined {
  return /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(value ?? "") ? undefined : "Use a BCP 47 language tag such as en-GB";
}

function emailValidation(value: string | undefined): string | undefined {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value ?? "") ? undefined : "Enter a valid email address";
}

function gitConfig(key: "user.name" | "user.email"): string | undefined {
  const result = Bun.spawnSync(["git", "config", "--get", key], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
  const value = new TextDecoder().decode(result.stdout).trim();
  return result.exitCode === 0 && value ? value : undefined;
}

export async function runNewWizard(options: NewWizardOptions): Promise<NewWorkplaceResult | undefined> {
  const io = common(options);
  const output = options.output ?? process.stdout;
  await assertNewWorkplaceTargetAvailable(options.target);
  intro(renderWordmark({ tty: output.isTTY === true, columns: output.columns, unicode: unicode && !options.noColor }), io);
  note("Create a place where intent can become durable outcome.", "Personal situated Workplace", io);

  const onCancel = () => { throw new Error("ENDROIT_WIZARD_CANCELLED"); };
  let workplace: { name: string; id: string };
  try {
    workplace = await group({
      name: () => text({ message: "Workplace name", placeholder: "My Studio", validate: required, ...io }),
      id: ({ results }) => text({ message: "Workplace identifier", initialValue: slugify(results.name ?? "workplace"), validate: slugValidation, ...io }),
    }, { onCancel }) as { name: string; id: string };
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "ENDROIT_WIZARD_CANCELLED") throw error;
    cancel("Cancelled. No files written.", io);
    return undefined;
  }

  let member: { name: string; id: string };
  try {
    member = await group({
      name: () => text({ message: "Your name", validate: required, ...io }),
      id: ({ results }) => text({ message: "Member identifier", initialValue: slugify(results.name ?? "member"), validate: slugValidation, ...io }),
    }, { onCancel }) as { name: string; id: string };
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "ENDROIT_WIZARD_CANCELLED") throw error;
    cancel("Cancelled. No files written.", io);
    return undefined;
  }

  const languageChoice = await select({
    message: "Workplace language",
    options: [
      { value: "en", label: "English" },
      { value: "fr", label: "Français" },
      { value: "custom", label: "Another language tag" },
    ],
    initialValue: "en",
    ...io,
  });
  if (isCancel(languageChoice)) {
    cancel("Cancelled. No files written.", io);
    return undefined;
  }
  const customLanguage = languageChoice === "custom" ? await text({ message: "BCP 47 language tag", placeholder: "en-GB", validate: languageValidation, ...io }) : languageChoice;
  if (isCancel(customLanguage)) {
    cancel("Cancelled. No files written.", io);
    return undefined;
  }

  let welcome: { deskName: string; deskId: string; tone: string; humor: string; durableChanges: string };
  try {
    welcome = await group({
      deskName: () => text({ message: "Private Desk name", initialValue: `${member.name}'s Desk`, validate: required, ...io }),
      deskId: () => text({ message: "Desk identifier", initialValue: `${member.id}-desk`.slice(0, 63), validate: slugValidation, ...io }),
      tone: () => text({ message: "Preferred tone", initialValue: "Direct, warm and concise.", validate: required, ...io }),
      humor: () => text({ message: "Humor", initialValue: "Light when it helps; never forced.", validate: required, ...io }),
      durableChanges: () => text({ message: "Where should durable interaction changes go?", initialValue: "Update this Desk WELCOME.md, never provider memory.", validate: required, ...io }),
    }, { onCancel });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "ENDROIT_WIZARD_CANCELLED") throw error;
    cancel("Cancelled. No files written.", io);
    return undefined;
  }

  const providers = await multiselect<NewProvider>({
    message: "Agent adapters",
    options: [
      { value: "codex", label: "Codex", hint: "AGENTS.md + fundamental Skills" },
      { value: "claude", label: "Claude", hint: "CLAUDE.md" },
    ],
    required: false,
    ...io,
  });
  if (isCancel(providers)) {
    cancel("Cancelled. No files written.", io);
    return undefined;
  }

  const knownName = options.gitAuthor?.name ?? gitConfig("user.name");
  const knownEmail = options.gitAuthor?.email ?? gitConfig("user.email");
  note(knownName && knownEmail ? `${knownName} <${knownEmail}>` : "Git identity is incomplete.", "Git identity", io);
  const authorName = knownName ?? await text({ message: "Git author name", validate: required, ...io });
  if (isCancel(authorName)) {
    cancel("Cancelled. No files written.", io);
    return undefined;
  }
  const authorEmail = knownEmail ?? await text({ message: "Git author email", validate: emailValidation, ...io });
  if (isCancel(authorEmail)) {
    cancel("Cancelled. No files written.", io);
    return undefined;
  }

  const plan = planNewWorkplace({
    kind: "NewWorkplaceRequest",
    version: 1,
    target: options.target,
    workplace,
    member: { ...member, language: customLanguage },
    desk: { id: welcome.deskId, name: welcome.deskName, welcome: { tone: welcome.tone, humor: welcome.humor, durableChanges: welcome.durableChanges } },
    providers,
    git: { initialize: true, commits: true, author: { name: authorName, email: authorEmail } },
  }, { profile: options.profile, cliCommand: options.cliCommand });
  note(renderNewWorkplacePreview(plan), "Exact preview · no files written", io);
  const consent = await confirm({ message: "Create exactly this Workplace?", initialValue: false, active: "Create", inactive: "Cancel", ...io });
  if (isCancel(consent) || !consent) {
    cancel("Cancelled. No files written.", io);
    return undefined;
  }

  let result: NewWorkplaceResult | undefined;
  await tasks([{ title: "Create, initialize Git, compile and check", task: async () => {
    result = await applyNewWorkplace(plan, plan.revision);
    return "Workplace is ready";
  } }], io);
  if (!result) throw new Error("Workplace creation did not return a result");
  outro(`Ready. Open this folder in your Agent:\n${result.mount}`, io);
  return result;
}
