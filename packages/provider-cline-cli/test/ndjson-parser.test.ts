import { describe, it, expect } from "vitest"
import {
  parseLine,
  createNdjsonSplitter,
  isSayText,
  isSayCompletion,
  isApiReqFinished,
  isTaskStarted,
  pickText,
  isPartial,
} from "../src/ndjson-parser.js"

describe("parseLine", () => {
  it("parses a valid object line", () => {
    const ev = parseLine('{"type":"task_started","taskId":"abc"}')
    expect(ev).not.toBeNull()
    expect(ev!.type).toBe("task_started")
  })

  it("returns null for invalid JSON", () => {
    expect(parseLine("not json")).toBeNull()
    expect(parseLine("{")).toBeNull()
  })

  it("returns null for non-objects", () => {
    expect(parseLine("123")).toBeNull()
    expect(parseLine('"a string"')).toBeNull()
    expect(parseLine("[1,2,3]")).toBeNull()
    expect(parseLine("null")).toBeNull()
  })

  it("returns null when type field is missing or not a string", () => {
    expect(parseLine("{}")).toBeNull()
    expect(parseLine('{"type":42}')).toBeNull()
  })
})

describe("type guards", () => {
  it("recognizes say.text events", () => {
    const ev = parseLine('{"type":"say","say":"text","text":"hello","partial":false}')!
    expect(isSayText(ev)).toBe(true)
    expect(pickText(ev)).toBe("hello")
    expect(isPartial(ev)).toBe(false)
  })

  it("recognizes partial say.text", () => {
    const ev = parseLine('{"type":"say","say":"text","text":"hel","partial":true}')!
    expect(isSayText(ev)).toBe(true)
    expect(isPartial(ev)).toBe(true)
  })

  it("recognizes say.completion_result", () => {
    const ev = parseLine('{"type":"say","say":"completion_result","text":"done"}')!
    expect(isSayCompletion(ev)).toBe(true)
  })

  it("recognizes api_req_finished and exposes token counts", () => {
    const ev = parseLine('{"type":"say","say":"api_req_finished","tokensIn":100,"tokensOut":50}')!
    expect(isApiReqFinished(ev)).toBe(true)
    if (isApiReqFinished(ev)) {
      expect(ev.tokensIn).toBe(100)
      expect(ev.tokensOut).toBe(50)
    }
  })

  it("recognizes task_started", () => {
    const ev = parseLine('{"type":"task_started","taskId":"x"}')!
    expect(isTaskStarted(ev)).toBe(true)
  })

  it("returns null text from pickText when text field is missing or empty", () => {
    expect(pickText(parseLine('{"type":"say","say":"text"}')!)).toBeNull()
    expect(pickText(parseLine('{"type":"say","say":"text","text":""}')!)).toBeNull()
  })
})

describe("createNdjsonSplitter", () => {
  it("splits chunks on newlines", () => {
    const s = createNdjsonSplitter()
    expect(s.push("a\nb\n")).toEqual(["a", "b"])
  })

  it("buffers partial lines across chunks", () => {
    const s = createNdjsonSplitter()
    expect(s.push("hel")).toEqual([])
    expect(s.push("lo\nwor")).toEqual(["hello"])
    expect(s.push("ld\n")).toEqual(["world"])
  })

  it("flush returns trailing line without newline", () => {
    const s = createNdjsonSplitter()
    s.push("partial")
    expect(s.flush()).toEqual(["partial"])
    // After flush the buffer is empty.
    expect(s.flush()).toEqual([])
  })

  it("ignores empty lines", () => {
    const s = createNdjsonSplitter()
    expect(s.push("\n\na\n\n")).toEqual(["a"])
  })

  it("handles realistic multi-event stream", () => {
    const s = createNdjsonSplitter()
    const stream =
      '{"type":"task_started"}\n' +
      '{"type":"say","say":"text","text":"hi","partial":true}\n' +
      '{"type":"say","say":"text","text":"hi there","partial":false}\n' +
      '{"type":"say","say":"completion_result","text":"hi there"}\n'
    const lines = s.push(stream)
    expect(lines).toHaveLength(4)
    const events = lines.map(parseLine)
    expect(events.every((e) => e !== null)).toBe(true)
  })
})
