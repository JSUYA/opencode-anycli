import { spawn } from "node:child_process"
import { describe, expect, it } from "vitest"
import { readProcStat, subtreeCpu } from "../src/cline-acp-runner.js"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const linux = process.platform === "linux"

describe.skipIf(!linux)("subtreeCpu health probe (state-based, not time-based)", () => {
  it("reports a busy process as making CPU progress", async () => {
    const child = spawn("node", ["-e", "const end=Date.now()+4000;while(Date.now()<end){}"], { stdio: "ignore" })
    try {
      await sleep(300)
      const before = subtreeCpu(child.pid!)
      await sleep(1200)
      const after = subtreeCpu(child.pid!)
      expect(before.alive).toBe(true)
      expect(after.alive).toBe(true)
      // A spinning process advances CPU jiffies → watchdog would NOT kill it.
      expect(after.cpu).toBeGreaterThan(before.cpu)
    } finally {
      child.kill("SIGKILL")
    }
  })

  it("reports a sleeping (blocked) process as making NO CPU progress", async () => {
    const child = spawn("sleep", ["5"], { stdio: "ignore" })
    try {
      await sleep(300)
      const before = subtreeCpu(child.pid!)
      await sleep(1200)
      const after = subtreeCpu(child.pid!)
      expect(after.alive).toBe(true)
      // Idle/blocked → cpu flat → watchdog would treat as deadlocked.
      expect(after.cpu).toBe(before.cpu)
    } finally {
      child.kill("SIGKILL")
    }
  })

  it("counts a busy CHILD's CPU toward the parent subtree (long-command guard)", async () => {
    // Parent sleeps (0 CPU) but spawns a spinning child: the subtree must still
    // show progress so a cline blocked on a long command isn't killed.
    const parent = spawn("sh", ["-c", "node -e 'const e=Date.now()+4000;while(Date.now()<e){}' & wait"], {
      stdio: "ignore",
    })
    try {
      await sleep(400)
      const before = subtreeCpu(parent.pid!)
      await sleep(1200)
      const after = subtreeCpu(parent.pid!)
      expect(after.alive).toBe(true)
      expect(after.cpu).toBeGreaterThan(before.cpu)
    } finally {
      parent.kill("SIGKILL")
    }
  })

  it("reports a dead process as not alive", async () => {
    const child = spawn("sleep", ["30"], { stdio: "ignore" })
    const pid = child.pid!
    await new Promise<void>((r) => {
      child.on("exit", () => r())
      child.kill("SIGKILL")
    })
    await sleep(100)
    expect(subtreeCpu(pid).alive).toBe(false)
    expect(readProcStat(pid)).toBeNull()
  })
})
