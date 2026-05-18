// End-to-end coverage: every installed oh-my-anycli skill must also be
// dispatchable via plain prose (no slash command). Mirrors
// skill-bypass-coverage.test.ts but exercises the natural-language path
// (`detectSkillNaturalLanguage` / `detectSkillNaturalLanguageInHandoff`)
// instead of the structured `<command-instruction>` block.
//
// Why this matters: opencode TUI only emits slash-command rewrites for
// known prefixes. When users type prose like "X 스킬로 분석해줘" or
// "use the X skill", custom cline builds ignore the directive and the
// skill never loads. The natural-language bypass closes that gap.
//
// Strategy
//   1. Discover every SKILL.md on the machine.
//   2. For each skill build 5 trigger phrasings (3 KO + 2 EN) and run
//      each through doGenerate with a fakeCline that exits 99 on
//      invocation. Bypass MUST short-circuit cline.
//   3. Cross-check with a false-positive guard: mentioning a skill name
//      WITHOUT a trigger token (e.g. "tell me about the X skill")
//      should NOT fire the bypass.

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
  const names: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const skillPath = join(root, entry.name, "SKILL.md")
    if (!existsSync(skillPath)) continue
    const name = readSkillName(skillPath) ?? entry.name
    names.push(name)
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
  const dir = mkdtempSync(join(tmpdir(), "skill-nl-coverage-"))
  const path = join(dir, "cline-must-not-run")
  writeFileSync(path, "#!/usr/bin/env bash\necho FAIL-cline-was-invoked >&2\nexit 99\n", "utf8")
  chmodSync(path, 0o755)
  return { dir, path, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/**
 * Synthesize the prompt shape opencode passes for a natural-language
 * skill request. The provider needs BOTH the user text (so the detector
 * can find the trigger) AND the `<available_skills>` catalog (so the
 * closed-world dictionary admits the skill name) inside the handoff.
 *
 * We assemble a minimal system message containing only the available_skills
 * block and the orchestrator-style system context, then a user message
 * with the prose request.
 */
function buildPrompt(skillName: string, userText: string): unknown[] {
  const systemContent = [
    "You are the orchestrator.",
    "",
    "<available_skills>",
    `  <skill>`,
    `    <name>${skillName}</name>`,
    `    <description>placeholder description</description>`,
    `    <location>file:///tmp/${skillName}/SKILL.md</location>`,
    `  </skill>`,
    "</available_skills>",
  ].join("\n")
  return [
    { role: "system", content: systemContent },
    { role: "user", content: userText },
  ]
}

/** All trigger phrasings we promise to recognise per skill. */
function naturalLanguageTriggers(skill: string): { label: string; prompt: string }[] {
  return [
    { label: "ko-skill-particle", prompt: `${skill} 스킬로 이 코드 분석해줘.` },
    { label: "ko-ro-verb", prompt: `${skill}로 분석해줘.` },
    { label: "ko-eul-apply", prompt: `${skill}을 적용해줘.` },
    { label: "en-use-skill", prompt: `Please use the ${skill} skill to review this.` },
    { label: "en-apply", prompt: `apply ${skill} now.` },
  ]
}

const installed = discoverInstalledSkills()

describe("oh-my-anycli skill natural-language coverage", () => {
  it(`discovers at least one installed skill (found ${installed.length})`, () => {
    expect(installed.length).toBeGreaterThan(0)
  })

  // Cartesian product: every skill × every trigger phrasing.
  // Fail-loud: bypass MUST fire and the dispatched skill MUST equal the
  // injected name (no cross-skill misattribution under longest-match
  // policy, no false-negative under common trigger forms).
  const cases = installed.flatMap((skill) =>
    naturalLanguageTriggers(skill).map(({ label, prompt }) => ({ skill, label, prompt })),
  )

  it.each(cases)(
    "skill `$skill` fires on $label trigger",
    async ({ skill, prompt }) => {
      const cline = makeFakeCline()
      try {
        const model = new ClineLanguageModel("default", {
          command: cline.path,
          timeoutMs: 5000,
        })
        const result = await model.doGenerate({
          prompt: buildPrompt(skill, prompt),
          tools: [{ type: "function", name: "skill" }],
        } as unknown as Parameters<typeof model.doGenerate>[0])

        expect(result.finishReason).toMatchObject({ unified: "tool-calls" })
        expect(result.content).toHaveLength(1)
        expect(result.content[0]).toMatchObject({
          type: "tool-call",
          toolName: "skill",
          input: JSON.stringify({ name: skill }),
        })
        const meta = result.providerMetadata?.["cline"] as
          | { skillBypassSource?: string; skillSlashBypass?: string }
          | undefined
        // Telemetry: this path is the natural-language source, not slash.
        expect(meta?.skillBypassSource).toBe("natural-language")
        // Legacy field preserved (carries the same skill name on both paths).
        expect(meta?.skillSlashBypass).toBe(skill)
      } finally {
        cline.cleanup()
      }
    },
  )
})

describe("oh-my-anycli skill natural-language coverage — false-positive guards", () => {
  // Bare mentions WITHOUT a trigger token must NOT fire the bypass.
  // Otherwise asking "what does X skill do?" would dispatch X — which
  // would be wrong (user is asking ABOUT the skill, not asking to RUN it).
  const benign = [
    "tell me about the karpathy-guidelines skill",
    "I want to learn about code-review",
    "is there a skill called dead-code-finder?",
    "what does the todo-harvester skill do?",
    "explain the explain-code skill in plain English",
  ]
  it.each(benign)("benign mention `%s` does NOT fire bypass", async (prompt) => {
    const dir = mkdtempSync(join(tmpdir(), "skill-nl-fp-"))
    const fakeCline = join(dir, "cline")
    // This time cline IS the path that runs — emit a noop completion so
    // the test can prove that we DID reach cline (bypass not fired) and
    // got a normal finish.
    writeFileSync(
      fakeCline,
      [
        "#!/usr/bin/env node",
        "process.stdout.write(JSON.stringify({ type:'say', say:'completion_result', text:'noop', partial:false }) + '\\n')",
      ].join("\n"),
      "utf8",
    )
    chmodSync(fakeCline, 0o755)
    try {
      const model = new ClineLanguageModel("default", { command: fakeCline, timeoutMs: 5000 })
      const result = await model.doGenerate({
        prompt: buildPrompt("karpathy-guidelines", prompt),
        tools: [{ type: "function", name: "skill" }],
      } as unknown as Parameters<typeof model.doGenerate>[0])
      // Normal cline output reached us — bypass did NOT fire.
      expect(result.finishReason).toMatchObject({ unified: "stop" })
      const meta = result.providerMetadata?.["cline"] as
        | { skillBypassSource?: string }
        | undefined
      expect(meta?.skillBypassSource).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("oh-my-anycli skill natural-language coverage — closed-world enforcement", () => {
  it("does NOT dispatch a skill that isn't in available_skills, even when prose matches the trigger shape", async () => {
    // If a user types "phantom-skill 스킬로 분석해줘" but `phantom-skill`
    // isn't in the available_skills catalog, the bypass must NOT fire —
    // opencode would reject an unknown skill name anyway. Closed-world
    // dictionary keeps the bypass from manufacturing phantom dispatches.
    const dir = mkdtempSync(join(tmpdir(), "skill-nl-closed-world-"))
    const fakeCline = join(dir, "cline")
    writeFileSync(
      fakeCline,
      [
        "#!/usr/bin/env node",
        "process.stdout.write(JSON.stringify({ type:'say', say:'completion_result', text:'noop', partial:false }) + '\\n')",
      ].join("\n"),
      "utf8",
    )
    chmodSync(fakeCline, 0o755)
    try {
      const model = new ClineLanguageModel("default", { command: fakeCline, timeoutMs: 5000 })
      const result = await model.doGenerate({
        prompt: buildPrompt("real-skill", "phantom-skill 스킬로 분석해줘"),
        tools: [{ type: "function", name: "skill" }],
      } as unknown as Parameters<typeof model.doGenerate>[0])
      expect(result.finishReason).toMatchObject({ unified: "stop" })
      const meta = result.providerMetadata?.["cline"] as
        | { skillBypassSource?: string }
        | undefined
      expect(meta?.skillBypassSource).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
