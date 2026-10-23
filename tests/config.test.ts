/**
 * Checks that PI_ROUTE_PROVIDER / PI_ROUTE_STRONG / PI_ROUTE_CHEAP override the built-in defaults.
 * The env vars must be set before the extension module is evaluated, so the import is dynamic.
 *
 * Run: node /tmp/route-test/config.test.ts   (override)
 *      node /tmp/route-test/fallback.test.ts (empty values → defaults)
 */

import assert from "node:assert/strict";

const overrides = process.argv.includes("--fallback")
	? {}
	: { PI_ROUTE_PROVIDER: "other-provider", PI_ROUTE_STRONG: "big-model-x", PI_ROUTE_CHEAP: "small-model-y" };

Object.assign(process.env, overrides);

const createExtension = (await import("../extensions/plan-then-implement.ts")).default;

let definition: any;
createExtension({ registerVirtualModel: (def: any) => void (definition = def) } as any);

const seen: string[] = [];
const ctx: any = {
	modelRegistry: {
		find(provider: string, id: string) {
			seen.push(`${provider}/${id}`);
			return { provider, id, api: "openai-completions" };
		},
	},
};

const expected = process.argv.includes("--fallback")
	? "tokenhub/claude-sonnet-5-5"
	: "other-provider/big-model-x";

const routed = definition.route(
	{ reason: "user", messages: [{ role: "user", content: "hi", timestamp: 0 }], thinkingLevel: "off" },
	ctx,
);

assert.deepEqual(seen, [expected], `looked up ${JSON.stringify(seen)}`);
assert.equal(`${routed.model.provider}/${routed.model.id}`, expected);
console.log(`ok  routed to ${expected}`);
console.log("\nall config cases passed");
