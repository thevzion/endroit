import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { isWorkplaceIgnored, parseWorkplaceIgnore } from "./index.ts";

type AdoptionEntry = { path: string; bytes: number; digest: `sha256:${string}` };

function digest(bytes: string | Uint8Array): `sha256:${string}` {
  return `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export async function previewAdoption(options: { source: string; outDir: string; ignore?: string }) {
  const source = resolve(options.source);
  const outDir = resolve(options.outDir);
  try {
    await stat(outDir);
    throw new Error(`Adoption Preview target already exists: ${outDir}`);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("ENOENT")) throw error;
  }
  const rules = parseWorkplaceIgnore(options.ignore ?? ".git/\nnode_modules/\ndist/\n.endroit/\n");
  const entries: AdoptionEntry[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      const local = relative(source, path).split(sep).join("/");
      if (isWorkplaceIgnored(rules, local)) continue;
      if (entry.isSymbolicLink()) throw new Error(`Adoption source contains a symlink: ${local}`);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        const bytes = await readFile(path);
        entries.push({ path: local, bytes: bytes.byteLength, digest: digest(bytes) });
        if (entries.length > 1000) throw new Error("Adoption source exceeds 1000 files");
      }
    }
  };
  await visit(source);
  const packageEntry = entries.find((entry) => entry.path === "package.json");
  const packageJson = packageEntry ? JSON.parse(await readFile(join(source, packageEntry.path), "utf8")) as { name?: string } : undefined;
  const slug = String(packageJson?.name ?? basename(source)).replace(/^@[^/]+\//, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "site";
  const manifest = {
    kind: "AdoptionPreview",
    version: "human/workplace-preview@1",
    source,
    lens: { kind: packageEntry ? "software-site" : "directory", label: packageJson?.name ?? basename(source) },
    map: entries,
    target: {
      mount: "<chosen-mount>",
      sharedRoot: "workplace/",
      site: `checkouts/sites/${slug}/`,
      sourceDisposition: "bind-sovereign-site; do-not-copy-or-absorb",
    },
    projections: ["WORKPLACE-PREVIEW.md", "preview-manifest.json"],
  };
  const revision = digest(json(manifest));
  const markdown = `# Workplace Adoption Preview\n\nStatus: **preview-only**  \nContract: \`human/workplace-preview@1\`  \nRevision: \`${revision}\`\n\n## Lens\n\n- Source: \`${source}\`\n- Kind: **${manifest.lens.kind}**\n- Label: **${manifest.lens.label}**\n\n## Map\n\n${entries.map((entry) => `- \`${entry.path}\` — ${entry.bytes} bytes — \`${entry.digest}\``).join("\n") || "- No eligible file."}\n\n## Target\n\n- Create a separate Workplace Mount only after explicit consent.\n- Keep the source sovereign; bind it as \`${manifest.target.site}\`.\n- Never copy it into the shared Root, initialize a parallel Git repository, host, publish or deliver.\n\n## Correction and Apply\n\nCorrect the Lens, Map or Target by regenerating this Preview. Preview without Apply is a valid Outcome. This release does not ship Apply.\n`;
  const temp = join(dirname(outDir), `.${basename(outDir)}.tmp-${process.pid}-${crypto.randomUUID()}`);
  await mkdir(temp, { recursive: true });
  try {
    await writeFile(join(temp, "WORKPLACE-PREVIEW.md"), markdown, { flag: "wx" });
    await writeFile(join(temp, "preview-manifest.json"), json({ ...manifest, revision }), { flag: "wx" });
    await rename(temp, outDir);
  } catch (error) {
    await rm(temp, { recursive: true, force: true });
    throw error;
  }
  return { outDir, revision, files: ["WORKPLACE-PREVIEW.md", "preview-manifest.json"] };
}
