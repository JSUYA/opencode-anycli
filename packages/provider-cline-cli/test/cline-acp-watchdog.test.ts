import { spawn } from "node:child_process"
import { describe, expect, it } from "vitest"
import { readProcStat, subtreeProgress } from "../src/cline-acp-runner.js"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const linux = process.platform === "linux"

describe.skipIf(!linux)("subtreeProgress health probe (state-based, not time-based)", () => {
  it("reports a busy process as making CPU progress", async () => {
    const child = spawn("node", ["-e", "const end=Date.now()+4000;while(Date.now()<end){}"], { stdio: "ignore" })
    try {
      await sleep(300)
      const before = subtreeProgress(child.pid!)
      await sleep(1200)
      const after = subtreeProgress(child.pid!)
      expect(before.alive).toBe(true)
      expect(after.alive).toBe(true)
      // A spinning process advances CPU jiffies → watchdog would NOT kill it.
      expect(after.cpu).toBeGreaterThan(before.cpu)
    } finally {
      child.kill("SIGKILL")
    }
  })

  it("reports an I/O-bound process (idle CPU) as making progress", async () => {
    // A process that reads a file in a tight loop moves rchar bytes while
    // burning almost no CPU. This is the shape of a cline streaming from a
    // remote model or reading+rewriting its task-history file — the case a
    // CPU-only probe used to misread as a deadlock and false-kill.
    const child = spawn("sh", ["-c", "while :; do cat /proc/self/status >/dev/null; done"], { stdio: "ignore" })
    try {
      await sleep(300)
      const before = subtreeProgress(child.pid!)
      await sleep(1200)
      const after = subtreeProgress(child.pid!)
      expect(after.alive).toBe(true)
      // I/O bytes advance even though this is not a CPU-spin → NOT killed.
      expect(after.io).toBeGreaterThan(before.io)
    } finally {
      child.kill("SIGKILL")
    }
  })

  it("reports a truly idle process (no CPU, no I/O) as making no progress", async () => {
    const child = spawn("sleep", ["5"], { stdio: "ignore" })
    try {
      await sleep(300)
      const before = subtreeProgress(child.pid!)
      await sleep(1200)
      const after = subtreeProgress(child.pid!)
      expect(after.alive).toBe(true)
      // A sleeping process advances neither CPU nor I/O → the watchdog treats
      // this (after the full silence window) as deadlocked.
      expect(after.cpu).toBe(before.cpu)
      expect(after.io).toBe(before.io)
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
      const before = subtreeProgress(parent.pid!)
      await sleep(1200)
      const after = subtreeProgress(parent.pid!)
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
    expect(subtreeProgress(pid).alive).toBe(false)
    expect(readProcStat(pid)).toBeNull()
  })
})
