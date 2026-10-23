/**
 * Unit tests for the Plan→Implement router. No API calls: the router is driven directly with
 * synthetic messages, so every branch is checked deterministically.
 *
 * Run: node /tmp/route-test/routes.test.ts
 */

import assert from "node:assert/strict";
import createExtension from "../extensions/plan-then-implement.ts";

// --- harness -------------------------------------------------------------------------------

let definition: any;
const fakePi = {
	registerVirtualModel(def: any) {
		definition = def;
	},
} as any;

createExtension(fakePi);
assert.ok(definition, "extension did not register a virtual model");

const ctx: any = {
	modelRegistry: {
		find(provider: string, id: string) {
			return provider === "tokenhub" ? { provider, id, api: "openai-completions" } : undefined;
		},
	},
};

const user = (text: string) => ({ role: "user", content: text, timestamp: 0 });
const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }], timestamp: 0 });
const CHEAP = "deepseek-v4.1-flash";
const call = (name: string, command: string, id = "1", model = CHEAP) => ({
	role: "assistant",
	model,
	content: [{ type: "toolCall", id, name, arguments: { command } }],
	timestamp: 0,
});
const toolOk = (toolName: string, text = "ok", id = "1") => ({
	role: "toolResult",
	toolName,
	toolCallId: id,
	content: [{ type: "text", text }],
	isError: false,
	timestamp: 0,
});
const toolFail = (toolName: string, text: string, id = "1") => ({
	role: "toolResult",
	toolName,
	toolCallId: id,
	content: [{ type: "text", text }],
	isError: true,
	timestamp: 0,
});

function route(reason: any, messages: any[], state?: any) {
	const result = definition.route({ reason, messages, thinkingLevel: "off", state }, ctx);
	return { model: result.model.id, phase: result.state?.phase };
}

function check(name: string, actual: { model: string; phase?: string }, expected: { model: string; phase?: string }) {
	assert.deepEqual(actual, expected, `${name}: got ${JSON.stringify(actual)}`);
	console.log(`ok  ${name} -> ${actual.model} (${actual.phase ?? "no state"})`);
}

// --- cases ---------------------------------------------------------------------------------

check("user message starts on the strong model", route("user", [user("add a --verbose flag")]), {
	model: "claude-sonnet-5-5",
	phase: "planning",
});

check("planning, no edit yet stays strong", route("continuation", [user("fix it"), assistant("looking")], { phase: "planning" }), {
	model: "claude-sonnet-5-5",
	phase: "planning",
});

check(
	"first successful edit hands over to the cheap model",
	route("continuation", [user("fix it"), toolOk("edit")], { phase: "planning" }),
	{ model: "deepseek-v4.1-flash", phase: "implementation" },
);

check(
	"failed edit does not count as implementation",
	route("continuation", [user("fix it"), toolFail("edit", "old_string not found")], { phase: "planning" }),
	{ model: "claude-sonnet-5-5", phase: "planning" },
);

check(
	"implementation continues on the cheap model",
	route("continuation", [user("fix it"), toolOk("edit"), toolOk("bash", "1 passing")], {
		phase: "implementation",
	}),
	{ model: "deepseek-v4.1-flash", phase: "implementation" },
);

check(
	"failing test escalates to the strong model",
	route(
		"continuation",
		[user("fix it"), call("edit", "", "1"), toolOk("edit"), toolFail("bash", "1 failing\nAssertionError", "2")],
		{
		phase: "implementation",
	}),
	{ model: "claude-sonnet-5-5", phase: "escalated" },
);

check(
	"failing test in non-zero output escalates without isError",
	route(
		"continuation",
		[user("fix it"), call("edit", "", "1"), toolOk("edit"), toolOk("bash", "2 failed, 5 passed", "2")],
		{
		phase: "implementation",
	}),
	{ model: "claude-sonnet-5-5", phase: "escalated" },
);

check(
	"compiler error escalates to the strong model",
	route(
		"continuation",
		[user("fix it"), call("edit", "", "1"), toolOk("edit"), toolOk("bash", "src/a.ts(3,7): error TS2322", "2")],
		{
		phase: "implementation",
	}),
	{ model: "claude-sonnet-5-5", phase: "escalated" },
);

check(
	"escalation is sticky for the rest of the turn",
	route("continuation", [user("fix it"), toolOk("edit"), toolOk("bash", "3 passing")], { phase: "escalated" }),
	{ model: "claude-sonnet-5-5", phase: "escalated" },
);

check(
	"a failure left by the strong model does not escalate",
	route(
		"continuation",
		[
			user("fix it"),
			call("bash", "sed -i 's/a - b/a + b/' a.mjs", "5", "claude-sonnet-5-5"),
			toolOk("bash", "edited", "5"),
			toolOk("bash", "1 failing", "6"),
		],
		{ phase: "implementation" },
	),
	{ model: "deepseek-v4.1-flash", phase: "implementation" },
);

check(
	"a stale failure from planning does not escalate after the switch",
	route(
		"continuation",
		[user("fix it"), toolFail("bash", "1 failing\nAssertionError", "8"), toolOk("edit")],
		{ phase: "implementation" },
	),
	{ model: "deepseek-v4.1-flash", phase: "implementation" },
);

check(
	"a failure with no change behind it does not escalate",
	route("continuation", [user("fix it"), toolFail("bash", "2 failing")], { phase: "implementation" }),
	{ model: "deepseek-v4.1-flash", phase: "implementation" },
);

check(
	"a failure after a shell edit escalates",
	route(
		"continuation",
		[
			user("fix it"),
			call("bash", "sed -i 's/a - b/a + b/' a.mjs", "9"),
			toolOk("bash", "edited", "9"),
			toolOk("bash", "2 failing", "10"),
		],
		{ phase: "implementation" },
	),
	{ model: "claude-sonnet-5-5", phase: "escalated" },
);

check(
	"noisy but successful command does not escalate",
	route("continuation", [user("fix it"), toolOk("edit"), toolOk("bash", "0 failed, 7 passed")], {
		phase: "implementation",
	}),
	{ model: "deepseek-v4.1-flash", phase: "implementation" },
);

check(
	"unrelated failed command does not escalate",
	route("continuation", [user("fix it"), toolOk("edit"), toolFail("bash", "grep: no matches")], {
		phase: "implementation",
	}),
	{ model: "deepseek-v4.1-flash", phase: "implementation" },
);

// --- edit tools vary by installed extensions ------------------------------------------------

for (const name of ["edit", "write", "apply_patch", "replace_match", "insert", "str_replace"]) {
	check(
		`${name} starts implementation`,
		route("continuation", [user("fix it"), toolOk(name)], { phase: "planning" }),
		{ model: "deepseek-v4.1-flash", phase: "implementation" },
	);
}

for (const name of ["read", "grep", "find", "ls", "fff", "bash"]) {
	check(
		`${name} does not start implementation`,
		route("continuation", [user("fix it"), toolOk(name, "no changes")], { phase: "planning" }),
		{ model: "claude-sonnet-5-5", phase: "planning" },
	);
}

// --- implementation detection through bash --------------------------------------------------

check(
	"sed -i counts as the start of implementation",
	route("continuation", [user("fix it"), call("bash", "sed -i 's/a - b/a + b/' a.mjs"), toolOk("bash", "done")], {
		phase: "planning",
	}),
	{ model: "deepseek-v4.1-flash", phase: "implementation" },
);

check(
	"heredoc file writes count as implementation",
	route("continuation", [user("fix it"), call("bash", "cat > b.mjs <<'EOF'"), toolOk("bash", "")], {
		phase: "planning",
	}),
	{ model: "deepseek-v4.1-flash", phase: "implementation" },
);

check(
	"failed shell command does not start implementation",
	route(
		"continuation",
		[user("fix it"), call("bash", "sed -i 's/a - b/a + b/' a.mjs"), toolFail("bash", "sed: no such file")],
		{ phase: "planning" },
	),
	{ model: "claude-sonnet-5-5", phase: "planning" },
);

check(
	"read-only shell commands do not start implementation",
	route(
		"continuation",
		[user("fix it"), call("bash", "node --test > out.jsonl 2>&1"), toolOk("bash", "1 passing")],
		{ phase: "planning" },
	),
	{ model: "claude-sonnet-5-5", phase: "planning" },
);

// --- retry budget before escalating ---------------------------------------------------------

check(
	"the first strike escalates by default",
	route(
		"continuation",
		[user("fix it"), call("edit", "", "1"), toolOk("edit"), toolFail("bash", "1 failing", "2")],
		{ phase: "implementation" },
	),
	{ model: "claude-sonnet-5-5", phase: "escalated" },
);

check("retry escalates to the strong model", route("retry", [user("fix it"), toolOk("edit")], { phase: "implementation" }), {
	model: "claude-sonnet-5-5",
	phase: "planning",
});

check("compaction and other direct requests use the strong model", route("direct", [user("fix it")], { phase: "implementation" }), {
	model: "claude-sonnet-5-5",
	phase: undefined,
});

check("a new user message restarts planning on the strong model", route("user", [user("next task")], { phase: "escalated" }), {
	model: "claude-sonnet-5-5",
	phase: "planning",
});

// Without the strong model there is nothing to fall back to, so the request errors instead of
// silently running on a model the user did not choose.
const brokenCtx: any = { modelRegistry: { find: () => undefined } };
assert.throws(
	() => definition.route({ reason: "user", messages: [user("x")], thinkingLevel: "off" }, brokenCtx),
	/not in the catalog/,
);
console.log("ok  missing physical model surfaces an error instead of a silent downgrade");

console.log("\nall router cases passed");
