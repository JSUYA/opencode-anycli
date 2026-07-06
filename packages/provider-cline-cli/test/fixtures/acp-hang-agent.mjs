#!/usr/bin/env node
// Fake ACP agent for tests: completes the handshake, streams ONE assistant
// message chunk on prompt, then holds the turn open forever (never resolves
// prompt()). Mirrors cline hitting an interactive ask (mistake_limit_reached /
// followup) that ACP can't answer. Args (--acp --yolo ...) are ignored.
import { AgentSideConnection, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk"
import { Readable, Writable } from "node:stream"

const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin))

new AgentSideConnection(
  (conn) => ({
    async initialize() {
      return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} }
    },
    async newSession() {
      return { sessionId: "fake-session-1" }
    },
    async prompt(params) {
      await conn.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "I'm having trouble. Continue? 1) yes 2) no" },
        },
      })
      // Hold the turn open forever — the runner's watchdog must rescue it.
      return new Promise(() => {})
    },
    async cancel() {},
    async authenticate() {
      return {}
    },
  }),
  stream,
)
