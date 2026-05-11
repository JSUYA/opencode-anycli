import { describe, expect, it, vi } from "vitest"
import plugin from "../src/tui.js"

describe("exit-confirm TUI plugin", () => {
  it("exports the plugin id and tui entry point", () => {
    expect(plugin.id).toBe("opencode-anycli:exit-confirm")
    expect(typeof plugin.tui).toBe("function")
  })

  it("loads without a keyInput emitter", async () => {
    const onDispose = vi.fn()
    await plugin.tui({
      renderer: {},
      lifecycle: { onDispose },
      ui: {
        dialog: {
          clear: vi.fn(),
          replace: vi.fn(),
        },
        DialogConfirm: vi.fn(),
      },
      command: { trigger: vi.fn() },
    } as never)

    expect(onDispose).toHaveBeenCalledTimes(1)
  })

  it("intercepts plain Ctrl+C and opens the confirmation dialog", async () => {
    let keypress: ((evt: Record<string, unknown>) => void) | null = null
    let onClose: (() => void) | undefined
    const replace = vi.fn((_factory: unknown, close: () => void) => {
      onClose = close
    })
    const onDispose = vi.fn()
    const preventDefault = vi.fn()

    await plugin.tui({
      renderer: {
        keyInput: {
          on: vi.fn((_event: string, handler: (evt: Record<string, unknown>) => void) => {
            keypress = handler
          }),
        },
      },
      lifecycle: { onDispose },
      ui: {
        dialog: {
          clear: vi.fn(),
          replace,
        },
        DialogConfirm: vi.fn(),
      },
      command: { trigger: vi.fn() },
    } as never)

    keypress?.({
      ctrl: true,
      name: "c",
      shift: false,
      meta: false,
      option: false,
      preventDefault,
    })

    expect(replace).toHaveBeenCalledTimes(1)
    expect(preventDefault).toHaveBeenCalledTimes(1)
    onClose?.()
    expect(onDispose).toHaveBeenCalledTimes(1)
  })

  it("does not intercept modified Ctrl+C terminal shortcuts", async () => {
    let keypress: ((evt: Record<string, unknown>) => void) | null = null
    const replace = vi.fn()
    const preventDefault = vi.fn()

    await plugin.tui({
      renderer: {
        keyInput: {
          on: vi.fn((_event: string, handler: (evt: Record<string, unknown>) => void) => {
            keypress = handler
          }),
        },
      },
      lifecycle: { onDispose: vi.fn() },
      ui: {
        dialog: {
          clear: vi.fn(),
          replace,
        },
        DialogConfirm: vi.fn(),
      },
      command: { trigger: vi.fn() },
    } as never)

    keypress?.({
      ctrl: true,
      name: "c",
      shift: true,
      meta: false,
      option: false,
      preventDefault,
    })

    expect(replace).not.toHaveBeenCalled()
    expect(preventDefault).not.toHaveBeenCalled()
  })

  it("confirms exit on a second plain Ctrl+C while armed", async () => {
    let keypress: ((evt: Record<string, unknown>) => void) | null = null
    const clear = vi.fn()
    const trigger = vi.fn()
    const preventDefault = vi.fn()

    await plugin.tui({
      renderer: {
        keyInput: {
          on: vi.fn((_event: string, handler: (evt: Record<string, unknown>) => void) => {
            keypress = handler
          }),
        },
      },
      lifecycle: { onDispose: vi.fn() },
      ui: {
        dialog: {
          clear,
          replace: vi.fn(),
        },
        DialogConfirm: vi.fn(),
      },
      command: { trigger },
    } as never)

    const ctrlC = {
      ctrl: true,
      name: "c",
      shift: false,
      meta: false,
      option: false,
      preventDefault,
    }
    keypress?.(ctrlC)
    keypress?.(ctrlC)

    expect(clear).toHaveBeenCalledTimes(1)
    expect(trigger).toHaveBeenCalledWith("app.exit")
    expect(preventDefault).toHaveBeenCalledTimes(2)
  })
})
