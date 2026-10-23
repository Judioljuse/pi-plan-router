/**
 * Plan→Implement router.
 *
 * Registers `route/auto`, a virtual model that keeps the expensive model on planning and puts the
 * cheap model on implementation:
 *
 * - Planning: the strong model explores, writes the plan, and makes the first edit.
 * - Implementation: after the first successful edit, or the first shell command that writes files,
 *   the rest of the turn runs on the cheap model.
 * - Escalation: a failing test or build command hands the turn back to the strong model, which
 *   keeps it until the user writes again. Retries escalate too.
 * - Compaction summaries and other requests outside the agent loop always use the strong model,
 *   so long sessions never degrade their own summaries.
 *
 * The phase is router state, so it follows the session branch through `/tree` and compaction.
 *
 * Usage: pi --model route/auto
 */

import type { Message } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	ModelRoute,
	ModelRouteRequest,
} from "@earendil-works/pi-coding-agent";

/**
 * Provider and physical models to route between, overridable per machine so one file works
 * everywhere: PI_ROUTE_PROVIDER, PI_ROUTE_STRONG, and PI_ROUTE_CHEAP.
 */
function setting(name: string, fallback: string): string {
	const value = process.env[name]?.trim();
	return value ? value : fallback;
}

const PROVIDER = setting("PI_ROUTE_PROVIDER", "tokenhub");
const STRONG = setting("PI_ROUTE_STRONG", "claude-sonnet-5-5");
const CHEAP = setting("PI_ROUTE_CHEAP", "deepseek-v4.1-flash");

/**
 * Tools that change files, matched by name because the name depends on the extensions installed
 * (`edit`/`write` in core, `replace_match`/`insert` from the hashline editor, and so on).
 */
const MUTATION_TOOL_NAME =
	/(?:^|_)(?:edit|write|patch|replace|insert|append|apply|copy|move|rename|delete|create|mkdir)(?:$|_)/i;

/**
 * Shell commands that write to the working tree. Agents often implement through `bash` instead of
 * the edit tools, and an implementation phase that never starts saves nothing.
 */
const MUTATING_COMMAND: readonly RegExp[] = [
	/\bsed\s+(?:-\w*i\w*|--in-place)/,
	/\bperl\s+-\w*i/,
	/\bgit\s+apply\b/,
	/\bpatch\s+-p/,
	// `cat > file` and `tee` writes, but not pipelines that only capture output.
	/\b(?:cat|tee)\s+(?:-a\s+)?>\s*[^\s&|/]/,
	// Redirections into source files, ignoring `/dev/null`, `2>&1`, and captured logs.
	/(?:^|[\s;|&])>{1,2}\s*(?!&|\/dev\/null)\S+\.(?:[cm]?[jt]sx?|py|go|rs|rb|java|kt|swift|php|cs|c|h|cpp|hpp|sh|sql|ya?ml|toml|md|css|scss|html?)\b/,
];

/** Commands whose failure means the code does not work. */
const VERIFY_COMMAND =
	/\b(tests?|specs?|build|tsc|pytest|jest|vitest|mocha|cargo|go\s+test|make|npm|pnpm|yarn|bun|gradle|mvn)\b/i;

/** Output that means the code does not work. */
const FAILURE_OUTPUT: readonly RegExp[] = [
	/\bFAILED\b/,
	/\b[1-9]\d*\s+(?:failing|failed)\b/i,
	/\bAssertionError\b/,
	/\bTraceback \(most recent call last\)/,
	/\berror TS\d{4}\b/,
	/\berror\[E\d{4}\]/,
	/\bSyntaxError:/,
	/\bpanicked at\b/,
	/\bcompilation failed\b/i,
];

interface RouterState {
	/** planning: strong model. implementation: cheap model. escalated: strong model took the turn back. */
	phase: "planning" | "implementation" | "escalated";
}

type Request = ModelRouteRequest<RouterState>;
type ToolResult = Extract<Message, { role: "toolResult" }>;

function resultText(message: ToolResult): string {
	return message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

/** Messages produced since the last user message, which is where one turn starts. */
function sinceLastUser(messages: readonly Message[]): readonly Message[] {
	return messages.slice(messages.findLastIndex((message) => message.role === "user") + 1);
}

/** The commands of tool calls in this conversation, keyed by the id their result carries. */
function commandByCallId(messages: readonly Message[]): Map<string, string> {
	const commands = new Map<string, string>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type !== "toolCall") continue;
			const command = block.arguments.command;
			if (typeof command === "string") commands.set(block.id, command);
		}
	}
	return commands;
}

/** Whether implementation started: a successful edit tool, or a shell command that wrote files. */
function implementedThisTurn(messages: readonly Message[]): boolean {
	const commands = commandByCallId(messages);
	return sinceLastUser(messages).some((message) => isMutation(message, commands));
}

function isMutation(message: Message, commands: Map<string, string>): boolean {
	if (message.role !== "toolResult" || message.isError) return false;
	if (MUTATION_TOOL_NAME.test(message.toolName)) return true;
	const command = commands.get(message.toolCallId);
	return command !== undefined && MUTATING_COMMAND.some((pattern) => pattern.test(command));
}

function isFailure(message: Message): boolean {
	if (message.role !== "toolResult") return false;
	const text = resultText(message);
	if (FAILURE_OUTPUT.some((pattern) => pattern.test(text))) return true;
	// A test, build, or package command that exited non-zero.
	return message.isError && VERIFY_COMMAND.test(text);
}

/** Which model issued each tool call, keyed by the id its result carries. */
function modelByCallId(messages: readonly Message[]): Map<string, string> {
	const models = new Map<string, string>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type === "toolCall") models.set(block.id, message.model);
		}
	}
	return models;
}

/**
 * The cheap model changed the code and a check then failed, so the strong model takes the turn
 * back. A failure left by the strong model's own change does not count: picking that up is the
 * cheap model's job.
 */
function regressionThisTurn(messages: readonly Message[]): boolean {
	const commands = commandByCallId(messages);
	const models = modelByCallId(messages);
	const turn = sinceLastUser(messages);
	const lastMutation = turn.findLastIndex((message) => isMutation(message, commands));
	if (lastMutation === -1) return false;
	const mutation = turn[lastMutation];
	if (mutation.role !== "toolResult" || models.get(mutation.toolCallId) !== CHEAP) return false;
	return turn.slice(lastMutation + 1).some(isFailure);
}

function toPhysical(
	request: Request,
	ctx: ExtensionContext,
	id: string,
	state?: RouterState,
): ModelRoute<RouterState> {
	const model = ctx.modelRegistry.find(PROVIDER, id);
	if (!model) throw new Error(`Model ${PROVIDER}/${id} is not in the catalog`);
	return { model, thinkingLevel: request.thinkingLevel, state };
}

export default function (pi: ExtensionAPI) {
	pi.registerVirtualModel<RouterState>({
		provider: "route",
		id: "auto",
		name: "Plan→Implement",
		thinkingLevels: ["off"],
		// Shown before the first response; afterwards Pi uses the limits of the model that answered.
		contextWindow: 1_000_000,
		maxTokens: 64_000,
		route(request, ctx) {
			try {
				// Compaction summaries and extension calls: never on the cheap model.
				if (request.reason === "direct") return toPhysical(request, ctx, STRONG);

				// Overload, context overflow, or a failed request: the strong model takes over.
				if (request.reason === "retry") {
					return toPhysical(request, ctx, STRONG, { phase: "planning" });
				}

				// Every new user message starts a fresh plan on the strong model.
				if (request.reason === "user") {
					return toPhysical(request, ctx, STRONG, { phase: "planning" });
				}

				const state = request.state ?? { phase: "planning" as const };

				// The strong model changed the code: hand the rest of the turn to the cheap model.
				if (state.phase === "planning" && implementedThisTurn(request.messages)) {
					return toPhysical(request, ctx, CHEAP, { phase: "implementation" });
				}

				// The cheap model's change broke a check: escalate and stay escalated for this turn.
				if (state.phase === "implementation" && regressionThisTurn(request.messages)) {
					return toPhysical(request, ctx, STRONG, { phase: "escalated" });
				}

				return toPhysical(request, ctx, state.phase === "implementation" ? CHEAP : STRONG, state);
			} catch {
				// A throwing route fails the whole request, so degrade to the strong model instead.
				return toPhysical(request, ctx, STRONG);
			}
		},
	});
}
