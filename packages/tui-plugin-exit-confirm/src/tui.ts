// opencode TUI plugin (shipped by opencode-anycli) that adds a confirmation
// dialog on Ctrl+C instead of opencode's default "exit immediately" behaviour.
//
// How it hooks in:
//   1. opencode-anycli's tui.json removes `ctrl+c` from the `app_exit`
//      keybind so the component-level `keybind.match("app_exit", evt)`
//      checks in opencode's session/prompt routes stop firing on Ctrl+C.
//      It then rebinds the unused `username_toggle` keybind to `ctrl+c`
//      and registers our command on that name. `username_toggle` was
//      verified by full-tree grep to be defined ONLY in the keybind
//      schema — no opencode component, dialog, or built-in command
//      references it via `keybind.match()` or `keybind: "..."`. That
//      makes it the only keybind name with no upstream owner, so the
//      plugin command we attach to it is the sole handler.
//   2. The first attempt used `display_thinking`, but session routes
//      register an internal `session.toggle.thinking` command on that
//      keybind AFTER plugin load (route mounts when the user opens a
//      session) — and the command dispatcher prepends each
//      registration, so the route's command ends up first in the
//      iteration order and shadows the plugin handler. `username_toggle`
//      has no upstream registration to lose to.
//   3. On press we replace the dialog stack with a `DialogConfirm`. Y
//      confirms exit → triggers the built-in `app.exit` command (so the
//      shutdown path is exactly opencode's, not ours). N / Escape closes
//      the dialog. A second Ctrl+C while armed also confirms.
//
// We deliberately use no JSX — `api.ui.DialogConfirm({ … })` returns a
// JSX.Element directly and the dialog stack accepts a `() => JSX.Element`
// factory, so a tsx pipeline isn't needed in the plugin build.

import type { TuiPlugin, TuiPluginModule, TuiCommand } from "@opencode-ai/plugin/tui"

const REARM_WINDOW_MS = 5000

const tui: TuiPlugin = async (api) => {
  // Diagnostic key logger (temporary, gated by env var so production users
  // never pay the cost). Set OPENCODE_ANYCLI_KEYLOG=/path/to/log and every
  // raw keypress opentui sees gets appended as JSON. Used to diagnose the
  // "shift+enter submits instead of inserting newline" report — we need to
  // know whether opentui's parser sees the shift modifier or just `\r`.
  if (process.env["OPENCODE_ANYCLI_KEYLOG"]) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require("node:fs") as typeof import("node:fs")
      const path = process.env["OPENCODE_ANYCLI_KEYLOG"]
      api.renderer.keyInput.on("keypress", (evt) => {
        // After the keystroke is delivered, peek at whatever input element
        // currently has focus and capture its plainText. Lets us see if
        // textarea actually inserted a newline on Shift+Enter, separate
        // from how opentui parsed the keystroke. setImmediate so we run
        // AFTER opentui's textarea handlers have processed the event.
        setImmediate(() => {
          let bufferPlainText: string | undefined
          let bufferKind: string | undefined
          try {
            const focused = (api.renderer as unknown as { currentFocusedRenderable?: { plainText?: string; constructor?: { name?: string } } }).currentFocusedRenderable
            if (focused && typeof focused.plainText === "string") {
              bufferPlainText = focused.plainText
              bufferKind = focused.constructor?.name
            }
          } catch { /* ignore */ }
          try {
            fs.appendFileSync(
              path,
              JSON.stringify({
                ts: Date.now(),
                name: evt.name,
                ctrl: evt.ctrl,
                meta: evt.meta,
                shift: evt.shift,
                option: evt.option,
                source: evt.source,
                raw: evt.raw,
                sequence: evt.sequence,
                eventType: evt.eventType,
                code: evt.code,
                bufferPlainText,
                bufferKind,
              }) + "\n",
            )
          } catch { /* ignore logger errors */ }
        })
      })
    } catch { /* logger setup failed — ignore */ }
  }

  let armed = false
  let armedTimer: ReturnType<typeof setTimeout> | null = null

  const disarm = () => {
    armed = false
    if (armedTimer) {
      clearTimeout(armedTimer)
      armedTimer = null
    }
  }

  const confirmExit = () => {
    disarm()
    api.ui.dialog.clear()
    api.command.trigger("app.exit")
  }

  const showDialog = () => {
    // The second arg to dialog.replace is an onClose callback that opencode
    // invokes whenever the dialog stack is torn down — including the
    // external paths we don't otherwise observe: pressing Ctrl+C or Escape
    // while the dialog is open (handled in opencode/ui/dialog.tsx, line 85)
    // and any later dialog.clear() / dialog.replace() from elsewhere. We
    // hook disarm() here so a `Ctrl+C → Ctrl+C → Ctrl+C` sequence does
    // NOT skip straight to confirmExit on press 3 (the bug the user hit:
    // press 1 armed us, press 2 closed the dialog via dialog.tsx without
    // running our onCancel, press 3 found armed=true and exited silently).
    api.ui.dialog.replace(
      () =>
        api.ui.DialogConfirm({
          title: "Exit opencode-anycli?",
          // DialogConfirm wires Enter to whichever button is focused, ←/→
          // to switch focus, and Escape to cancel — there is no Y/N
          // keyboard shortcut. We default focus to Confirm so Enter alone
          // exits.
          message:
            "Enter to exit (Confirm is focused). " +
            "Press Escape or move to Cancel to keep the session open.",
          onConfirm: () => confirmExit(),
          onCancel: () => disarm(),
        }),
      () => disarm(),
    )
  }

  const onCtrlC = () => {
    if (armed) {
      // Armed AND user pressed Ctrl+C again WITHOUT the dialog being
      // open — only happens when the dialog is currently visible and
      // the user double-tapped within the rearm window. Treat as
      // confirmation to exit. (If the dialog was closed by an external
      // path between presses, the onClose callback we passed to
      // dialog.replace already disarmed us, so we won't end up here.)
      confirmExit()
      return
    }
    armed = true
    showDialog()
    armedTimer = setTimeout(() => {
      armed = false
      armedTimer = null
    }, REARM_WINDOW_MS)
  }

  api.command.register((): TuiCommand[] => [
    {
      title: "Exit opencode-anycli (with confirmation)",
      value: "opencode-anycli.exit-confirm",
      // See header for keybind selection rationale; in short:
      // username_toggle is defined in the schema but referenced nowhere
      // else in opencode's TUI source, so our handler is unopposed.
      keybind: "username_toggle",
      hidden: true,
      category: "System",
      onSelect: () => onCtrlC(),
    },
  ])

  api.lifecycle.onDispose(() => {
    if (armedTimer) clearTimeout(armedTimer)
    armedTimer = null
  })
}

const plugin: TuiPluginModule = {
  id: "opencode-anycli:exit-confirm",
  tui,
}

export default plugin
