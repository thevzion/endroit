# Adopt an Endroit workplace

This is Endroit's portable, pre-Home adoption guide. It is for an agent
helping a human recognize or create a Workplace before Endroit's generated
Front Door exists. [WORKPLACE.md](https://endroit.org/WORKPLACE.md) defines the
versioned Endroit profile; [INSTALL.md](https://endroit.org/install.md) is the
deterministic CLI appendix.

The agent guides. The CLI applies. The human approves.

## 1. Enter before adopting

Starting from the directory the human explicitly selected, look for
`endroit.json` in that directory and then its parents. Do not follow a symlink
to continue the search.

If a Home is found, stop this guide and enter through its generated Front
Door. Read its Floor Plan and use its tracked `node ./endroit.mjs` Console.
Never install a second Home over an existing one.

If no Home is found, offer two paths:

- **Start fresh** — create the smallest useful standalone Home for new work;
- **Bring what you have** — recognize existing repositories, instructions and
  methods, then transpose their responsibilities without moving them.

Do not create an adoption journal or retain the conversation.

## 2. Start fresh

Recommend one standalone Home in a new directory. State the destination, the
human Member and the Desk strategy, show the exact `endroit create` command,
then ask for approval before running it. Add optional Equipment, Rooms and
Sites only when the work already requires them.

Continue at [Apply and confirm](#6-apply-and-confirm).

## 3. Recognize what already exists

Ask the human to name the exact local roots that may be inspected. This is the
first consent boundary. Until it is granted, do not inspect any candidate
root.

After consent, make one shallow, local, read-only inventory limited to those
roots. Record only evidence useful for choosing a Workplace boundary, such as:

- repository roots, remotes, branches and working-tree state;
- top-level names and declared project manifests;
- existing public instructions, methods and documentation;
- likely responsibility boundaries and obvious relationships between roots.

Do not scan the user's home directory by default. Do not follow symlinks
outside the approved roots. Exclude credentials and secret-like files,
`.git/`, dependency directories, caches, generated output and build artifacts.
Do not modify, move, rename or normalize anything during recognition.

## 4. Recommend a candidate

Present more than one plausible Workplace when the evidence supports it. For
each candidate, name:

- the proposed Home boundary;
- what would remain a sovereign Site;
- the evidence for the placement;
- uncertainties and excluded sources;
- the trade-off against the other candidates.

Recommend one candidate. For a multi-repository environment, prefer a
standalone Home with the existing repositories declared as Sites and reached
through Desk-owned Routes. Use `init` only when one repository should also
contain the Home.

The human's candidate selection authorizes deeper analysis of that candidate
only. It does not authorize mutation.

## 5. Analyze and propose the map

Within the selected roots, analyze only the sources needed to transpose the
existing environment. When the provider offers native subagents, delegate
independent Site or responsibility boundaries with the same roots, exclusions
and read-only authority. Otherwise work sequentially. Never simulate
delegation or create a persistent agent registry.

Propose one explicit map covering the relevant:

- Home, Member and Desk;
- Rooms and Material;
- Equipment;
- Sites and Routes.

For every proposed destination, cite its source provenance, explain the
responsibility being made explicit and show the expected file and command
diff. Existing product files and checkouts stay where they are.

Ask separately for the exact phrase **Apply this map**. A candidate selection,
approval to analyze or general acknowledgement is not application authority.

## 6. Apply and confirm

After **Apply this map**, use only the approved Endroit operations: `create`,
`init`, `member`, `desk`, `equipment`, `room`, `site`, `route`, `build` and
`doctor`. Keep every mutation inside the accepted destinations and preserve
the Site repositories' source, history and permissions.

Run the tracked Home Console:

```bash
node ./endroit.mjs build
node ./endroit.mjs doctor
```

Report the observed result and any limit. Then ask for confirmation from a
fresh provider session entering through the generated Front Door. The adoption
is complete only when that session can identify the Home, relevant Room and
declared Sites without relying on the previous transcript.

This guide does not authorize retention, acceptance, delivery, commit,
push, publication or deployment.
