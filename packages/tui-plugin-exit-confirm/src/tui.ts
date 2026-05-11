// opencode TUI plugin (shipped by opencode-anycli) that adds a confirmation
// dialog on Ctrl+C instead of opencode's default "exit immediately" behaviour.
//
// How it hooks in:
//   1. opencode-anycli's tui.json removes `ctrl+c` from the `app_exit`
//      keybind so the component-level `keybind.match("app_exit", evt)`
//      checks in opencode's session/prompt routes stop firing on Ctrl+C.
//   2. The plugin attaches a global handler to opentui's renderer-level
//      `keyInput` emitter. Per @opentui/core's KeyHandler design, global
//      handlers run BEFORE renderable (component) handlers and can call
//      `evt.preventDefault()` to stop the event from propagating any
//      further — which means we don't need to piggyback on a keybind
//      name at all. Earlier versions of this plugin re-used the unused
//      `username_toggle` keybind, but opencode 1.14 dropped that name
//      and made the tui.json schema strict (`additionalProperties:
//      false`), so any reference to it now invalidates the whole file
//      and silently drops every keybind override with it. Intercepting
//      ctrl+c at the raw KeyEvent layer is schema-independent and
//      survives future opencode keybind renames.
//   3. On press we replace the dialog stack with a `DialogConfirm`. Y
//      confirms exit → triggers the built-in `app.exit` command (so the
//      shutdown path is exactly opencode's, not ours). N / Escape closes
//      the dialog. A second Ctrl+C while armed also confirms.
//
// We deliberately use no JSX — `api.ui.DialogConfirm({ … })` returns a
// JSX.Element directly and the dialog stack accepts a `() => JSX.Element`
// factory, so a tsx pipeline isn't needed in the plugin build.

import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"

const REARM_WINDOW_MS = 5000

const tui: TuiPlugin = async (api) => {
  // Plugin-load diagnostic. Gated by env var so production users pay
  // nothing. Useful when ctrl+c dialog mysteriously doesn't appear in
  // some environment: if this line never lands in the log file, the
  // plugin itself isn't being loaded by opencode (tui.json schema
  // rejection, wrong file:// URL, missing dist, etc.).
  if (process.env["OPENCODE_ANYCLI_EXIT_CONFIRM_DEBUG"]) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require("node:fs") as typeof import("node:fs")
      fs.appendFileSync(
        process.env["OPENCODE_ANYCLI_EXIT_CONFIRM_DEBUG"],
        `[${new Date().toISOString()}] exit-confirm plugin loaded\n`,
      )
    } catch { /* ignore */ }
  }

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
    api.command?.trigger("app.exit")
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

  // Global keypress interceptor. opentui dispatches keypress events to
  // renderer-level listeners (this one) BEFORE handing them to renderable
  // component-level handlers, and `evt.preventDefault()` aborts further
  // propagation — so opencode's session/prompt-route handlers never see
  // this ctrl+c. We test for `ctrl && name === "c"` with no other modifier
  // so that ctrl+shift+c (copy on most terminals) still goes through.
  api.renderer.keyInput.on("keypress", (evt) => {
    if (evt.ctrl && evt.name === "c" && !evt.shift && !evt.meta && !evt.option) {
      if (process.env["OPENCODE_ANYCLI_EXIT_CONFIRM_DEBUG"]) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const fs = require("node:fs") as typeof import("node:fs")
          fs.appendFileSync(
            process.env["OPENCODE_ANYCLI_EXIT_CONFIRM_DEBUG"],
            `[${new Date().toISOString()}] ctrl+c intercepted (armed=${armed})\n`,
          )
        } catch { /* ignore */ }
      }
      onCtrlC()
      evt.preventDefault()
    }
  })

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
