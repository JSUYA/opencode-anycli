// opencode TUI plugin (shipped by opencode-anycli) that adds a confirmation
// dialog on Ctrl+C instead of opencode's default "exit immediately" behaviour.
//
// How it hooks in:
//   1. opencode-anycli's tui.json removes `ctrl+c` from the `app_exit`
//      keybind so the component-level `keybind.match("app_exit", evt)`
//      checks in opencode's session/prompt routes stop firing on Ctrl+C.
//      It also rebinds the otherwise-unused `display_thinking` keybind to
//      `ctrl+c` — `display_thinking` was chosen because no opencode
//      component handler invokes it via direct `keybind.match()`; it is
//      only routed through the global command dispatcher in
//      `dialog-command.tsx`, so a plugin command claiming the same
//      keybind name has full control over what happens on press.
//   2. This plugin registers a single hidden TuiCommand with
//      `keybind: "display_thinking"`. The command dispatcher prepends
//      plugin registrations, so our handler fires before opencode's
//      built-in `display_thinking` command, which makes the dispatcher
//      `return` after our match (it stops at the first matching command).
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
    api.ui.dialog.replace(() =>
      api.ui.DialogConfirm({
        title: "Exit opencode-anycli?",
        // DialogConfirm wires Enter to whichever button is focused, ←/→ to
        // switch focus, and Escape to cancel — there is no Y/N keyboard
        // shortcut. We default the focus to Confirm so Enter alone exits.
        message:
          "Enter to exit (Confirm is focused). " +
          "Press Escape or move to Cancel to keep the session open.",
        onConfirm: () => confirmExit(),
        onCancel: () => disarm(),
      }),
    )
  }

  const onCtrlC = () => {
    if (armed) {
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
      // `display_thinking` is the only keybind opencode wires solely
      // through the global command dispatcher (no direct keybind.match()
      // in components); see header comment for the full reasoning.
      keybind: "display_thinking",
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
