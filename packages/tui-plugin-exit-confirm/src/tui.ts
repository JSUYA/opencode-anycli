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
