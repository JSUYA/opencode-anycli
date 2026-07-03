import { describe, it, expect, beforeEach } from "vitest"
import { EventEmitter } from "node:events"
import { Readable } from "node:stream"
import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { detectAcpSupport, clearAcpSupportCache } from "../src/cline-capabilities.js"

function fakeHelp(stdout: string, code = 0) {
  return ((_cmd: string, _args?: readonly string[], _opts?: object) => {
    const p = new EventEmitter() as EventEmitter & { stdout: Readable; stderr: Readable; kill: () => boolean }
    p.stdout = new Readable({ read() {} })
    p.stderr = new Readable({ read() {} })
    p.kill = () => true
    setTimeout(() => {
      p.stdout.push(stdout)
      p.stdout.push(null)
      p.stderr.push(null)
      setTimeout(() => p.emit("close", code, null), 2)
    }, 0)
    return p as unknown as ChildProcessWithoutNullStreams
  }) as unknown as typeof import("node:child_process").spawn
}

describe("detectAcpSupport", () => {
  beforeEach(() => clearAcpSupportCache())

  it("returns true when --help lists --acp", async () => {
    const help = "Options:\n  --json\n  --acp   Run in ACP mode\n  --tui\n"
    expect(await detectAcpSupport("cline", fakeHelp(help))).toBe(true)
  })

  it("returns false when --help has no --acp", async () => {
    const help = "Options:\n  --json\n  --auto-approve <boolean>\n"
    expect(await detectAcpSupport("cline", fakeHelp(help))).toBe(false)
  })

  it("caches the result per command (probe runs once)", async () => {
    let calls = 0
    const counting = ((c: string, a?: readonly string[], o?: object) => {
      calls++
      return (fakeHelp("  --acp\n") as unknown as (c: string, a?: readonly string[], o?: object) => ChildProcessWithoutNullStreams)(c, a, o)
    }) as unknown as typeof import("node:child_process").spawn
    await detectAcpSupport("clineX", counting)
    await detectAcpSupport("clineX", counting)
    expect(calls).toBe(1)
  })

  it("returns false when spawn throws", async () => {
    const throwing = (() => { throw new Error("ENOENT") }) as unknown as typeof import("node:child_process").spawn
    expect(await detectAcpSupport("missing", throwing)).toBe(false)
  })
})
