// Runtime detection of cline CLI capabilities.
//
// cline-sr's flag surface changed across versions (0.5.1 ships `--acp`, 0.6.0
// removed it). We probe `<command> --help` once per command and cache the
// result so the provider can auto-select the ACP vs subprocess transport
// without the user hand-editing `mode`.

import { spawn as nodeSpawn } from "node:child_process"

type SpawnFn = typeof nodeSpawn

const acpSupportCache = new Map<string, Promise<boolean>>()

/** True iff `<command> --help` advertises a `--acp` flag. Cached per command. */
export function detectAcpSupport(command: string, spawnFn: SpawnFn = nodeSpawn): Promise<boolean> {
  let cached = acpSupportCache.get(command)
  if (cached === undefined) {
    cached = probeAcpSupport(command, spawnFn)
    acpSupportCache.set(command, cached)
  }
  return cached
}

/** Reset the probe cache (tests / cline upgrade). */
export function clearAcpSupportCache(): void {
  acpSupportCache.clear()
}

function probeAcpSupport(command: string, spawnFn: SpawnFn): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false
    const done = (v: boolean) => {
      if (settled) return
      settled = true
      resolve(v)
    }
    let child: ReturnType<SpawnFn>
    try {
      child = spawnFn(command, ["--help"], { stdio: ["ignore", "pipe", "pipe"] })
    } catch {
      done(false)
      return
    }
    let out = ""
    const onData = (c: unknown) => {
      out += String(c)
    }
    child.stdout?.on("data", onData)
    child.stderr?.on("data", onData)
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL")
      } catch {
        /* ignore */
      }
      done(false)
    }, 5000)
    timer.unref?.()
    child.on("error", () => {
      clearTimeout(timer)
      done(false)
    })
    child.on("close", () => {
      clearTimeout(timer)
      done(/(^|\s)--acp(\s|$)/.test(out))
    })
  })
}
