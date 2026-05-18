// End-to-end coverage test: every oh-my-anycli skill on this machine
// is dispatchable via the slash-command bypass.
//
// Strategy
//   1. Discover every SKILL.md under XDG opencode-anycli skills/ dir
//      (env override OPENCODE_ANYCLI_SKILLS_DIR for CI).
//   2. For each skill, mint a synthetic prompt matching exactly what
//      opencode's TUI emits for `/<skill>`: a `<command-instruction>`
//      block with `Run the \`<skill-name>\` skill workflow`.
//   3. Run doGenerate against a fakeCline binary that EXIT 99 on invoke
//      — proving the bypass short-circuits before cline is even spawned.
//   4. Assert the V3 result: finishReason `tool-calls`, content carries
//      a `skill` tool-call with `{ name: "<skill-name>" }`,
//      providerMetadata.cline.skillSlashBypass matches.
//
// What this test PROVES
//   - The bypass deterministically intercepts every installed skill.
//   - opencode receives a properly-shaped tool-call ready to dispatch.
//   - cline-cli compatibility is independent of the model (no subprocess
//     ever runs in this path).
//
// What it does NOT prove
//   - Whether opencode then actually loads SKILL.md content — that's
//     opencode-side runtime behavior, out of this package's scope.

import { describe, expect, it } from "vitest"
import { existsSync, readdirSync, readFileSync, chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir, homedir } from "node:os"
import { join } from "node:path"
import { ClineLanguageModel } from "../src/language-model.js"

function discoverInstalledSkills(): string[] {
  const root =
    process.env["OPENCODE_ANYCLI_SKILLS_DIR"] ??
    join(homedir(), ".config", "opencode-anycli", "opencode", "skills")
  if (!existsSync(root)) return []
  const entries = readdirSync(root, { withFileTypes: true })
  const names: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const skillPath = join(root, entry.name, "SKILL.md")
    if (!existsSync(skillPath)) continue
    // Cross-check the frontmatter `name:` field against the dir name.
    // Some skills may declare a slightly different canonical id (rare).
    // We trust the frontmatter when present, else the dir name.
    const frontmatter = readSkillName(skillPath) ?? entry.name
    names.push(frontmatter)
  }
  names.sort()
  return names
}

function readSkillName(skillMd: string): string | null {
  try {
    const head = readFileSync(skillMd, "utf8").slice(0, 2000)
    const m = head.match(/^name:\s*([A-Za-z0-9_:\-]+)\s*$/m)
    return m?.[1] ?? null
  } catch {
    return null
  }
}

function makeFakeCline(): { dir: string; path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "skill-bypass-coverage-"))
  const path = join(dir, "cline-must-not-run")
  writeFileSync(path, "#!/usr/bin/env bash\necho FAIL-cline-was-invoked >&2\nexit 99\n", "utf8")
  chmodSync(path, 0o755)
  return { dir, path, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function commandInstructionFor(skillName: string): string {
  return [
    "<command-instruction>",
    `Run the \`${skillName}\` skill workflow on the user's request.`,
    "</command-instruction>",
    "",
    "do the thing.",
  ].join("\n")
}

const installed = discoverInstalledSkills()

describe("oh-my-anycli skill bypass coverage", () => {
  it(`discovers at least one installed skill (found ${installed.length})`, () => {
    // If this fails on a developer machine, set OPENCODE_ANYCLI_SKILLS_DIR
    // or install oh-my-anycli before running this suite. We don't skip
    // silently because the rest of the test below depends on enumeration.
    expect(installed.length).toBeGreaterThan(0)
  })

  // it.each with an empty list compiles to a "no tests run" success which
  // is misleading. The guard above turns that into a hard failure so
  // missing skills are loud.
  it.each(installed)(
    "skill `%s` is dispatched via slash-command bypass without spawning cline",
    async (skillName) => {
      const cline = makeFakeCline()
      try {
        const model = new ClineLanguageModel("default", {
          command: cline.path,
          timeoutMs: 5000,
        })
        const result = await model.doGenerate({
          prompt: [{ role: "user", content: commandInstructionFor(skillName) }],
          tools: [{ type: "function", name: "skill" }],
        } as unknown as Parameters<typeof model.doGenerate>[0])

        // Bypass path assertions: cline was NOT invoked (it would have
        // returned exit 99) AND we got back a clean skill tool-call.
        expect(result.finishReason).toMatchObject({ unified: "tool-calls" })
        expect(result.content).toHaveLength(1)
        expect(result.content[0]).toMatchObject({
          type: "tool-call",
          toolName: "skill",
          input: JSON.stringify({ name: skillName }),
        })
        const meta = result.providerMetadata?.["cline"] as
          | { skillSlashBypass?: string; opencodeCalls?: number }
          | undefined
        expect(meta?.skillSlashBypass).toBe(skillName)
        expect(meta?.opencodeCalls).toBe(1)
      } finally {
        cline.cleanup()
      }
    },
  )
})

describe("oh-my-anycli skill bypass coverage — variant phrasings", () => {
  // opencode's TUI uses one canonical phrasing today, but the regex is
  // intentionally tolerant of small wording / casing shifts. Lock the
  // variants we promise to handle so we notice if a future opencode
  // release changes the phrasing.
  const variants = [
    "Run the `code-review` skill workflow on the user's request.",
    "Run the `karpathy-guidelines` skill workflow.", // trailing period only
    "RUN THE `dead-code-finder` SKILL WORKFLOW now.", // all-caps
    "  Run\tthe   `todo-harvester`\nskill\nworkflow   ", // whitespace mess
  ]
  const expected = ["code-review", "karpathy-guidelines", "dead-code-finder", "todo-harvester"]
  it.each(variants.map((v, i) => [v, expected[i]] as const))(
    "phrasing variant matches → %s → skill name `%s`",
    async (variant, want) => {
      const cline = makeFakeCline()
      try {
        const model = new ClineLanguageModel("default", {
          command: cline.path,
          timeoutMs: 5000,
        })
        const result = await model.doGenerate({
          prompt: [
            {
              role: "user",
              content: `<command-instruction>\n${variant}\n</command-instruction>\nbody.`,
            },
          ],
          tools: [{ type: "function", name: "skill" }],
        } as unknown as Parameters<typeof model.doGenerate>[0])
        expect(result.finishReason).toMatchObject({ unified: "tool-calls" })
        const meta = result.providerMetadata?.["cline"] as { skillSlashBypass?: string } | undefined
        expect(meta?.skillSlashBypass).toBe(want)
      } finally {
        cline.cleanup()
      }
    },
  )
})
