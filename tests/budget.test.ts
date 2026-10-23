// PI_ROUTE_ESCALATE_AFTER=2: the cheap model gets one retry before the strong model takes over.
import assert from "node:assert/strict";
process.env.PI_ROUTE_ESCALATE_AFTER = "2";

const createExtension = (await import("../extensions/plan-then-implement.ts")).default;
let def: any;
createExtension({ registerVirtualModel: (d: any) => void (def = d) } as any);

const ctx: any = { modelRegistry: { find: (provider: string, id: string) => ({ provider, id }) } };
const CHEAP = "deepseek-v4.1-flash";
const turn = [
	{ role: "user", content: "fix it" },
	{ role: "assistant", model: CHEAP, content: [{ type: "toolCall", id: "1", name: "edit", arguments: {} }] },
	{ role: "toolResult", toolName: "edit", toolCallId: "1", content: [{ type: "text", text: "ok" }], isError: false },
	{ role: "toolResult", toolName: "bash", toolCallId: "2", content: [{ type: "text", text: "1 failing" }], isError: false },
];

const first = def.route({ reason: "continuation", messages: turn, thinkingLevel: "off", state: { phase: "implementation" } }, ctx);
assert.equal(first.model.id, CHEAP, "first strike keeps the cheap model");
assert.equal(first.state.strikes, 1);

const second = def.route({ reason: "continuation", messages: turn, thinkingLevel: "off", state: first.state }, ctx);
assert.equal(second.model.id, "claude-sonnet-5-5", "second strike escalates");
assert.equal(second.state.phase, "escalated");

console.log("ok  PI_ROUTE_ESCALATE_AFTER=2 gives the cheap model one retry");
