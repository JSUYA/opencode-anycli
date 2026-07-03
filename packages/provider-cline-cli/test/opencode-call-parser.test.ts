import { describe, expect, it } from "vitest"
import {
  OpencodeCallParser,
  SUPPORTED_OPENCODE_CALL_TOOLS,
  buildProtocolSection,
  detectSkillSlashCommand,
  detectSubagentDispatches,
  detectSubagentDispatchesInHandoff,
  expandOpencodeCall,
  wasSubagentDispatchedInHandoff,
} from "../src/opencode-call-parser.js"

describe("OpencodeCallParser", () => {
  it("extracts a single complete tag in one feed", () => {
    const p = new OpencodeCallParser()
    const out = p.feed(
      'preface text <opencode-call name="skill">{"name":"code-review"}</opencode-call> trailing',
    )
    expect(out.calls).toEqual([{ toolName: "skill", input: { name: "code-review" } }])
    expect(out.text).toBe("preface text  trailing")
  })

  it("handles a tag split across two chunks", () => {
    const p = new OpencodeCallParser()
    const first = p.feed('hi <opencode-call name="task">{"sub')
    // mid-tag — nothing emitted yet aside from the prelude
    expect(first.calls).toEqual([])
    expect(first.text).toBe("hi ")
    const second = p.feed(
      'agent_type":"build","description":"do x","prompt":"x"}</opencode-call>',
    )
    expect(second.calls).toEqual([
      { toolName: "task", input: { subagent_type: "build", description: "do x", prompt: "x" } },
    ])
    expect(second.text).toBe("")
  })

  it("retains the trailing prefix across feeds (no early flush of partial '<openc')", () => {
    const p = new OpencodeCallParser()
    const a = p.feed("the answer is <openc")
    // Only the safe prefix should have been flushed; the partial-open suffix
    // must stay buffered for the next chunk.
    expect(a.text).toBe("the answer is ")
    const b = p.feed('ode-call name="skill">{}</opencode-call>')
    expect(b.calls).toEqual([{ toolName: "skill", input: {} }])
    expect(b.text).toBe("")
  })

  it("forwards plain text untouched when no tag is present", () => {
    const p = new OpencodeCallParser()
    const out = p.feed("just talking, nothing to call")
    expect(out.calls).toEqual([])
    expect(out.text).toBe("just talking, nothing to call")
  })

  it("emits multiple tag occurrences in a single chunk", () => {
    const p = new OpencodeCallParser()
    const raw =
      '<opencode-call name="skill">{"name":"a"}</opencode-call>\n' +
      '<opencode-call name="skill">{"name":"b"}</opencode-call>'
    const out = p.feed(raw)
    expect(out.calls.map((c) => c.input)).toEqual([{ name: "a" }, { name: "b" }])
    expect(out.text).toBe("")
  })

  it("eats a single trailing newline after a tag so output stays clean", () => {
    const p = new OpencodeCallParser()
    const out = p.feed('<opencode-call name="skill">{"name":"x"}</opencode-call>\nrest')
    expect(out.calls).toHaveLength(1)
    expect(out.text).toBe("rest")
  })

  it("surfaces a malformed tag (invalid JSON body) as text", () => {
    const p = new OpencodeCallParser()
    const raw = '<opencode-call name="skill">not-json</opencode-call>'
    const out = p.feed(raw)
    expect(out.calls).toEqual([])
    expect(out.text).toBe(raw)
  })

  it("surfaces a tag missing the name attribute as text (rejects)", () => {
    const p = new OpencodeCallParser()
    const raw = '<opencode-call something="task">{}</opencode-call>'
    const out = p.feed(raw)
    expect(out.calls).toEqual([])
    expect(out.text).toBe(raw)
  })

  it("flushes an unclosed tag at end of stream so partial output is not silently dropped", () => {
    const p = new OpencodeCallParser()
    const a = p.feed('mid <opencode-call name="skill">{"name":"x"}')
    expect(a.calls).toEqual([])
    expect(a.text).toBe("mid ")
    const tail = p.flush()
    expect(tail.calls).toEqual([])
    expect(tail.text).toBe('<opencode-call name="skill">{"name":"x"}')
  })

  it("does not blow up on a CRLF newline after the tag", () => {
    const p = new OpencodeCallParser()
    const out = p.feed('<opencode-call name="skill">{}</opencode-call>\r\nafter')
    expect(out.calls).toHaveLength(1)
    expect(out.text).toBe("after")
  })

  it("accepts single-quoted name attribute", () => {
    const p = new OpencodeCallParser()
    const out = p.feed("<opencode-call name='task'>{}</opencode-call>")
    expect(out.calls).toEqual([{ toolName: "task", input: {} }])
  })

  it("handles a chunk that ends right at the open marker '<' (worst-case prefix detection)", () => {
    const p = new OpencodeCallParser()
    const a = p.feed("alpha<")
    // The trailing '<' must stay buffered as a potential prefix; otherwise
    // a tag arriving on the next chunk would be split and never parsed.
    expect(a.text).toBe("alpha")
    const b = p.feed('opencode-call name="skill">{}</opencode-call>')
    expect(b.calls).toHaveLength(1)
  })
})

describe("buildProtocolSection", () => {
  it("returns null when no recognized tool is registered", () => {
    expect(buildProtocolSection([{ name: "edit" }, { name: "bash" }])).toBeNull()
  })

  it("returns null on an empty tool list", () => {
    expect(buildProtocolSection([])).toBeNull()
  })

  it("includes only the task line when only task is registered", () => {
    const section = buildProtocolSection([{ name: "task" }, { name: "edit" }])
    expect(section).not.toBeNull()
    expect(section).toContain('name="task"')
    expect(section).not.toContain('name="skill"')
  })

  it("includes both lines when both task and skill are registered", () => {
    const section = buildProtocolSection([{ name: "task" }, { name: "skill" }])
    expect(section).not.toBeNull()
    expect(section).toContain('name="task"')
    expect(section).toContain('name="skill"')
    expect(section).toContain("[OPENCODE_CALL_PROTOCOL]")
    expect(section).toContain("[/OPENCODE_CALL_PROTOCOL]")
  })

  it("keeps the section compact (under 800 bytes)", () => {
    const section = buildProtocolSection([{ name: "task" }, { name: "skill" }]) ?? ""
    expect(Buffer.byteLength(section, "utf8")).toBeLessThan(800)
  })
})

describe("SUPPORTED_OPENCODE_CALL_TOOLS allow-list", () => {
  it("matches the names referenced in buildProtocolSection", () => {
    expect(SUPPORTED_OPENCODE_CALL_TOOLS.has("task")).toBe(true)
    expect(SUPPORTED_OPENCODE_CALL_TOOLS.has("skill")).toBe(true)
    expect(SUPPORTED_OPENCODE_CALL_TOOLS.has("bash")).toBe(false)
  })

  it("includes the use_subagents fan-out alias", () => {
    expect(SUPPORTED_OPENCODE_CALL_TOOLS.has("use_subagents")).toBe(true)
  })
})

describe("buildProtocolSection use_subagents guidance", () => {
  it("advertises use_subagents whenever task is registered", () => {
    const section = buildProtocolSection([{ name: "task" }]) ?? ""
    expect(section).toContain('name="use_subagents"')
    expect(section).toContain('"tasks"')
  })

  it("does NOT advertise use_subagents when task is absent", () => {
    const section = buildProtocolSection([{ name: "skill" }]) ?? ""
    expect(section).not.toContain("use_subagents")
  })
})

describe("expandOpencodeCall", () => {
  it("passes non-use_subagents calls through unchanged", () => {
    const call = { toolName: "task", input: { subagent_type: "a", description: "d", prompt: "p" } }
    expect(expandOpencodeCall(call)).toEqual([call])
  })

  it("fans out use_subagents tasks[] into one task call per entry", () => {
    const out = expandOpencodeCall({
      toolName: "use_subagents",
      input: {
        tasks: [
          { subagent_type: "code-reviewer", prompt: "review a.py", description: "review a" },
          { subagent_type: "security-auditor", prompt: "audit b.py" },
        ],
      },
    })
    expect(out).toEqual([
      { toolName: "task", input: { subagent_type: "code-reviewer", description: "review a", prompt: "review a.py" } },
      { toolName: "task", input: { subagent_type: "security-auditor", description: "security-auditor subtask", prompt: "audit b.py" } },
    ])
  })

  it("accepts agent/task alias fields and subagents[] key", () => {
    const out = expandOpencodeCall({
      toolName: "use_subagents",
      input: { subagents: [{ agent: "architect", task: "map the modules" }] },
    })
    expect(out).toEqual([
      { toolName: "task", input: { subagent_type: "architect", description: "architect subtask", prompt: "map the modules" } },
    ])
  })

  it("skips entries missing an agent name or prompt", () => {
    const out = expandOpencodeCall({
      toolName: "use_subagents",
      input: { tasks: [{ prompt: "no agent" }, { subagent_type: "x" }, { subagent_type: "ok", prompt: "go" }] },
    })
    expect(out).toEqual([
      { toolName: "task", input: { subagent_type: "ok", description: "ok subtask", prompt: "go" } },
    ])
  })

  it("returns [] for a use_subagents call with no valid entries", () => {
    expect(expandOpencodeCall({ toolName: "use_subagents", input: {} })).toEqual([])
    expect(expandOpencodeCall({ toolName: "use_subagents", input: { tasks: [] } })).toEqual([])
  })
})

describe("detectSubagentDispatches", () => {
  it("detects hyphenated agents named next to a subagent keyword (Korean)", () => {
    const out = detectSubagentDispatches(
      "code-reviewer 서브에이전트로 a.py를, security-auditor 서브에이전트로 b.py를 각각 리뷰하게 시켜줘.",
    )
    expect(out.map((d) => d.subagent_type)).toEqual(["code-reviewer", "security-auditor"])
    // each gets the clause that mentions it (so its target file is included)
    expect(out[0]!.prompt).toContain("a.py")
    expect(out[1]!.prompt).toContain("b.py")
  })

  it("detects @agent-name mentions", () => {
    const out = detectSubagentDispatches("Have @architect map the modules and @debugger check the crash.")
    expect(out.map((d) => d.subagent_type)).toEqual(["architect", "debugger"])
  })

  it("does NOT fire on a bare subagent keyword with no named agent", () => {
    expect(detectSubagentDispatches("여러 서브에이전트를 최대한 활용해서 분석해줘")).toEqual([])
    expect(detectSubagentDispatches("use subagents to analyze this project")).toEqual([])
  })

  it("dedupes a repeated agent and returns empty for empty input", () => {
    const out = detectSubagentDispatches("code-reviewer 에이전트로 리뷰하고 code-reviewer 에이전트 다시 실행")
    expect(out.map((d) => d.subagent_type)).toEqual(["code-reviewer"])
    expect(detectSubagentDispatches("")).toEqual([])
  })
})

describe("wasSubagentDispatchedInHandoff / detectSubagentDispatchesInHandoff", () => {
  const handoff = (userReq: string, extra = "") =>
    `[SOME_HEADER]\n${extra}\n[CURRENT_USER_REQUEST]\n${userReq}\n[/CURRENT_USER_REQUEST]\n`

  it("detects dispatches from the CURRENT_USER_REQUEST section", () => {
    const out = detectSubagentDispatchesInHandoff(handoff("code-reviewer 서브에이전트로 a.py 리뷰해줘"))
    expect(out.map((d) => d.subagent_type)).toEqual(["code-reviewer"])
  })

  it("loop-guard: skips an agent already dispatched earlier in the handoff", () => {
    const prior = '<tool-call name="task">{"subagent_type":"code-reviewer","description":"x","prompt":"y"}</tool-call>'
    expect(wasSubagentDispatchedInHandoff(handoff("code-reviewer 서브에이전트로 리뷰", prior), "code-reviewer")).toBe(true)
    const out = detectSubagentDispatchesInHandoff(handoff("code-reviewer 서브에이전트로 a.py 리뷰해줘", prior))
    expect(out).toEqual([])
  })

  it("returns [] when there is no CURRENT_USER_REQUEST section", () => {
    expect(detectSubagentDispatchesInHandoff("no markers here code-reviewer 서브에이전트")).toEqual([])
  })
})

describe("detectSkillSlashCommand", () => {
  it("extracts skill name from a typical command-instruction body", () => {
    const body =
      "Run the `karpathy-guidelines` skill workflow on the user's request.\nWhen to use: User invokes /karpathy..."
    expect(detectSkillSlashCommand([body])).toBe("karpathy-guidelines")
  })

  it("handles a multi-instruction list, returning the first match", () => {
    expect(
      detectSkillSlashCommand([
        "Something unrelated.",
        "Run the `code-review` skill workflow on the changes.",
        "Run the `todo-harvester` skill workflow next.",
      ]),
    ).toBe("code-review")
  })

  it("returns null when no directive is present", () => {
    expect(detectSkillSlashCommand(["The user wants help."])).toBeNull()
    expect(detectSkillSlashCommand([])).toBeNull()
  })

  it("rejects bogus skill names that don't look like kebab-case identifiers", () => {
    expect(
      detectSkillSlashCommand(["Run the `' OR 1=1; --` skill workflow on input."]),
    ).toBeNull()
  })

  it("is short-circuited by prior dispatch of the SAME skill (loop guard)", async () => {
    // Sanity check at the detector level: detection still fires; the
    // guard lives in language-model.ts (isSkillAlreadyDispatchedInHandoff).
    // Confirm the guard sees a prior dispatch in handoff text and the
    // detector itself doesn't depend on it.
    const { isSkillAlreadyDispatchedInHandoff } = await import(
      "../src/opencode-call-parser.js"
    )
    const handoff =
      'Previous turn:\n' +
      '<assistant index="2">\n' +
      '<tool-call name="skill">{"name":"karpathy-guidelines"}</tool-call>\n' +
      '</assistant>\n' +
      '[CURRENT_USER_REQUEST]\nfollow-up\n[/CURRENT_USER_REQUEST]'
    expect(isSkillAlreadyDispatchedInHandoff(handoff, "karpathy-guidelines")).toBe(true)
    // Different skill name → not blocked (user can chain skills).
    expect(isSkillAlreadyDispatchedInHandoff(handoff, "code-review")).toBe(false)
  })

  it("accepts plugin-namespaced skill ids (`plugin:skill-name`)", () => {
    expect(
      detectSkillSlashCommand(["Run the `caveman:caveman-review` skill workflow."]),
    ).toBe("caveman:caveman-review")
    expect(
      detectSkillSlashCommand(["Run the `github:gh-address-comments` skill workflow."]),
    ).toBe("github:gh-address-comments")
  })

  it("is case-insensitive on the surrounding directive but strict on the skill identifier", () => {
    expect(
      detectSkillSlashCommand(["RUN THE `karpathy-guidelines` SKILL WORKFLOW now."]),
    ).toBe("karpathy-guidelines")
  })
})
