import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type BashOperations,
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
	type EditOperations,
	type ReadOperations,
	type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { activateTmux, runTmuxBackend, sendTmuxInteractiveInput, tmuxCleanPromptHelpers, type TmuxBackend } from "./tmux-backend.ts";

type DirectBackend = {
	kind: "local" | "ssh";
	host?: string;
	cwd: string;
};

type Backend = DirectBackend | TmuxBackend;

type RawResult = {
	code: number | null;
	stdout: Buffer;
	stderr: Buffer;
	killed: boolean;
};

type CommandOptions = {
	input?: string | Buffer;
	signal?: AbortSignal;
	timeout?: number;
	env?: NodeJS.ProcessEnv;
	onStdout?: (data: Buffer) => void;
	onStderr?: (data: Buffer) => void;
};

const STATE_ENTRY = "shellgate-state";
const DEFAULT_CONNECT_TIMEOUT_SECONDS = 8;
const DEFAULT_COMMAND_TIMEOUT_SECONDS = 30;

const connectSchema = Type.Object({
	mode: Type.String({
		description: "Connection mode: status, clean, off, local, ssh, tmux, or ssh-tmux",
	}),
	host: Type.Optional(Type.String({ description: "SSH host, for ssh or ssh-tmux modes" })),
	target: Type.Optional(Type.String({ description: "tmux session or target pane, for tmux modes" })),
	path: Type.Optional(Type.String({ description: "Working directory on the selected host/session" })),
	create: Type.Optional(Type.Boolean({ description: "Create tmux session when missing; defaults to true" })),
});

const sendSchema = Type.Object({
	text: Type.Optional(Type.String({ description: "Literal text to send to the interactive program" })),
	key: Type.Optional(Type.String({ description: "tmux key name to send, such as C-c, C-d, Up, Down, or Enter" })),
	enter: Type.Optional(Type.Boolean({ description: "Press Enter after text; defaults to true for text sends" })),
});

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function splitArgs(input: string): string[] {
	const args: string[] = [];
	let current = "";
	let quote: "'" | '"' | null = null;
	let escaping = false;

	for (const char of input) {
		if (escaping) {
			current += char;
			escaping = false;
			continue;
		}
		if (char === "\\" && quote !== "'") {
			escaping = true;
			continue;
		}
		if ((char === "'" || char === '"') && quote === null) {
			quote = char;
			continue;
		}
		if (quote === char) {
			quote = null;
			continue;
		}
		if (/\s/.test(char) && quote === null) {
			if (current) args.push(current);
			current = "";
			continue;
		}
		current += char;
	}

	if (escaping) current += "\\";
	if (current) args.push(current);
	return args;
}

function parseHostPath(value: string): { host: string; path?: string } {
	const match = value.match(/^([^:]+):(.*)$/);
	if (!match) return { host: value };
	const [, host, path] = match;
	if (!path || /^[0-9]+$/.test(path)) return { host: value };
	return { host, path };
}

function describeBackend(backend: Backend | null): string {
	if (!backend) return "normal local shell";
	if (backend.kind === "local") return `local:${backend.cwd}`;
	if (backend.kind === "ssh") return `ssh:${backend.host}:${backend.cwd}`;
	const target = backend.displayTarget && backend.displayTarget !== backend.target ? `${backend.displayTarget} (${backend.target})` : backend.target;
	if (backend.host) return `ssh-tmux:${backend.host}:${target}:${backend.cwd}`;
	return `tmux:${target}:${backend.cwd}`;
}

function mapPath(path: string, localCwd: string, backend: Backend): string {
	if (!path.startsWith(localCwd)) return path;
	const suffix = path.slice(localCwd.length);
	return `${backend.cwd}${suffix}`;
}

function makeHostCommand(host: string | undefined, script: string): { command: string; args: string[] } {
	if (!host) {
		return { command: process.env.SHELL || "/bin/bash", args: ["-lc", script] };
	}
	return {
		command: "ssh",
		args: [
			"-o",
			"BatchMode=yes",
			"-o",
			`ConnectTimeout=${DEFAULT_CONNECT_TIMEOUT_SECONDS}`,
			host,
			`bash -lc ${shellQuote(script)}`,
		],
	};
}

function runHostRaw(host: string | undefined, script: string, options: CommandOptions = {}): Promise<RawResult> {
	return new Promise((resolve, reject) => {
		const hostCommand = makeHostCommand(host, script);
		const child = spawn(hostCommand.command, hostCommand.args, {
			stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
			env: host ? process.env : { ...process.env, ...options.env },
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let killed = false;
		let settled = false;

		const settle = (fn: () => void) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			fn();
		};

		const onAbort = () => {
			killed = true;
			child.kill();
		};

		const timer = options.timeout
			? setTimeout(() => {
					killed = true;
					child.kill();
				}, options.timeout * 1000)
			: undefined;

		options.signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout.on("data", (data: Buffer) => {
			stdout.push(data);
			options.onStdout?.(data);
		});
		child.stderr.on("data", (data: Buffer) => {
			stderr.push(data);
			options.onStderr?.(data);
		});
		child.on("error", (error) => settle(() => reject(error)));
		child.on("close", (code) =>
			settle(() =>
				resolve({
					code,
					stdout: Buffer.concat(stdout),
					stderr: Buffer.concat(stderr),
					killed,
				}),
			),
		);

		if (options.input !== undefined && child.stdin) {
			child.stdin.end(options.input);
		}
	});
}

async function runHostChecked(host: string | undefined, script: string, options: CommandOptions = {}): Promise<string> {
	const result = await runHostRaw(host, script, options);
	if (result.code !== 0) {
		const message = Buffer.concat([result.stdout, result.stderr]).toString().trim();
		throw new Error(message || `command failed with code ${result.code}`);
	}
	return result.stdout.toString();
}

async function runDirectBackend(
	backend: DirectBackend,
	command: string,
	cwd: string,
	options: CommandOptions = {},
): Promise<RawResult> {
	const targetCwd = mapPath(cwd, process.cwd(), backend);
	const script = `cd ${shellQuote(targetCwd)} && ${command}`;
	return runHostRaw(backend.kind === "ssh" ? backend.host : undefined, script, options);
}


async function runBackend(backend: Backend, command: string, cwd: string, options: CommandOptions = {}): Promise<RawResult> {
	if (backend.kind === "tmux") return runTmuxBackend(backend, command, cwd, options);
	return runDirectBackend(backend, command, cwd, options);
}

async function backendOutput(backend: Backend, command: string, cwd: string, options: CommandOptions = {}): Promise<string> {
	const result = await runBackend(backend, command, cwd, options);
	if (result.code !== 0) {
		const output = Buffer.concat([result.stdout, result.stderr]).toString().trim();
		throw new Error(output || `command failed with code ${result.code}`);
	}
	return result.stdout.toString();
}

function createReadOps(backend: Backend, localCwd: string): ReadOperations {
	return {
		async readFile(path) {
			const target = mapPath(path, localCwd, backend);
			const output = await backendOutput(backend, `base64 < ${shellQuote(target)}`, backend.cwd, {
				timeout: DEFAULT_COMMAND_TIMEOUT_SECONDS,
			});
			return Buffer.from(output.replace(/\s/g, ""), "base64");
		},
		async access(path) {
			const target = mapPath(path, localCwd, backend);
			await backendOutput(backend, `test -r ${shellQuote(target)}`, backend.cwd, {
				timeout: DEFAULT_COMMAND_TIMEOUT_SECONDS,
			});
		},
		async detectImageMimeType(path) {
			const target = mapPath(path, localCwd, backend);
			try {
				const mime = await backendOutput(backend, `file --mime-type -b ${shellQuote(target)}`, backend.cwd, {
					timeout: DEFAULT_COMMAND_TIMEOUT_SECONDS,
				});
				const value = mime.trim();
				return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(value) ? value : null;
			} catch {
				return null;
			}
		},
	};
}

function createWriteOps(backend: Backend, localCwd: string): WriteOperations {
	return {
		async writeFile(path, content) {
			const target = mapPath(path, localCwd, backend);
			const b64 = Buffer.from(content).toString("base64");
			await backendOutput(
				backend,
				`base64 -d > ${shellQuote(target)} <<'__SHELLGATE_B64__'\n${b64}\n__SHELLGATE_B64__`,
				backend.cwd,
				{ timeout: DEFAULT_COMMAND_TIMEOUT_SECONDS },
			);
		},
		async mkdir(dir) {
			const target = mapPath(dir, localCwd, backend);
			await backendOutput(backend, `mkdir -p ${shellQuote(target)}`, backend.cwd, {
				timeout: DEFAULT_COMMAND_TIMEOUT_SECONDS,
			});
		},
	};
}

function createEditOps(backend: Backend, localCwd: string): EditOperations {
	const readOps = createReadOps(backend, localCwd);
	const writeOps = createWriteOps(backend, localCwd);
	return {
		readFile: readOps.readFile,
		writeFile: writeOps.writeFile,
		async access(path) {
			const target = mapPath(path, localCwd, backend);
			await backendOutput(backend, `test -r ${shellQuote(target)} && test -w ${shellQuote(target)}`, backend.cwd, {
				timeout: DEFAULT_COMMAND_TIMEOUT_SECONDS,
			});
		},
	};
}

function createBashOps(backend: Backend, localCwd: string): BashOperations {
	return {
		async exec(command, cwd, { onData, signal, timeout, env }) {
			const result = await runBackend(backend, command, cwd || localCwd, {
				signal,
				timeout,
				env,
				onStdout: onData,
				onStderr: onData,
			});
			return { exitCode: result.code };
		},
	};
}

async function ensureDirectory(backend: Backend): Promise<void> {
	await backendOutput(backend, `test -d ${shellQuote(backend.cwd)}`, backend.cwd, {
		timeout: DEFAULT_CONNECT_TIMEOUT_SECONDS,
	});
}

async function resolveSshCwd(host: string, path?: string): Promise<string> {
	if (path) return path;
	return runHostChecked(host, "pwd", { timeout: DEFAULT_CONNECT_TIMEOUT_SECONDS }).then((value) => value.trim());
}


function serializeBackend(backend: Backend | null): Record<string, unknown> {
	if (!backend) return { kind: "off" };
	if (backend.kind !== "tmux") return { ...backend };
	return {
		kind: backend.kind,
		host: backend.host,
		target: backend.target,
		displayTarget: backend.displayTarget,
		cwd: backend.cwd,
	};
}

function restoreBackend(data: unknown): Backend | null {
	if (!data || typeof data !== "object") return null;
	const value = data as Record<string, unknown>;
	if (value.kind === "local" && typeof value.cwd === "string") return { kind: "local", cwd: value.cwd };
	if (value.kind === "ssh" && typeof value.host === "string" && typeof value.cwd === "string") {
		return { kind: "ssh", host: value.host, cwd: value.cwd };
	}
	if (value.kind === "tmux" && typeof value.target === "string" && typeof value.cwd === "string") {
		return {
			kind: "tmux",
			host: typeof value.host === "string" ? value.host : undefined,
			target: value.target,
			displayTarget: typeof value.displayTarget === "string" ? value.displayTarget : undefined,
			cwd: value.cwd,
			promptReady: false,
			promptActive: false,
		};
	}
	return null;
}

function commandHelp(): string {
	return [
		"ShellGate routes bash/read/write/edit through a selected shell backend.",
		"Usage:",
		"  /shellgate status",
		"  /shellgate off",
		"  /shellgate local /path",
		"  /shellgate ssh host[:/path]",
		"  /shellgate tmux session [/path]",
		"  /shellgate ssh-tmux host session [/path]",
		"  /shellgate clean",
		"Tmux tip: prefer a user-visible/current pi tmux session or pane when the user is observing; only create a new pane/session when requested or when no suitable visible pane exists.",
		"Docker tip: enter a container inside a user-visible tmux pane first, e.g. docker exec -it <container> bash, then /shellgate tmux <pane>; normal bash/read/write/edit run inside that container shell.",
		"Alias: /sg",
	].join("\n");
}

export default function (pi: ExtensionAPI) {
	const localCwd = process.cwd();
	const localBash = createBashTool(localCwd);
	const localRead = createReadTool(localCwd);
	const localWrite = createWriteTool(localCwd);
	const localEdit = createEditTool(localCwd);
	let activeBackend: Backend | null = null;

	const setStatus = (ctx: { ui?: { setStatus?: (key: string, value?: string) => void; theme?: { fg: (name: string, text: string) => string } } }) => {
		const status = activeBackend ? `ShellGate: ${describeBackend(activeBackend)}` : undefined;
		ctx.ui?.setStatus?.("shellgate", status && ctx.ui.theme ? ctx.ui.theme.fg("accent", status) : status);
	};

	const setBackend = (backend: Backend | null, ctx?: { ui?: { setStatus?: (key: string, value?: string) => void; theme?: { fg: (name: string, text: string) => string }; notify?: (message: string, type?: "info" | "warning" | "error") => void } }) => {
		activeBackend = backend;
		pi.appendEntry(STATE_ENTRY, serializeBackend(backend));
		if (ctx) {
			setStatus(ctx);
			ctx.ui?.notify?.(`ShellGate: ${describeBackend(backend)}`, "info");
		}
	};

	const connect = async (
		input: { mode: string; host?: string; target?: string; path?: string; create?: boolean },
		ctx?: { ui?: { setStatus?: (key: string, value?: string) => void; theme?: { fg: (name: string, text: string) => string }; notify?: (message: string, type?: "info" | "warning" | "error") => void } },
	): Promise<string> => {
		const mode = input.mode.toLowerCase();
		if (mode === "status") return describeBackend(activeBackend);
		if (["clean", "cleanup"].includes(mode)) {
			if (activeBackend?.kind !== "tmux") return "ShellGate clean is only needed for tmux backends";
			await tmuxCleanPromptHelpers(activeBackend.host, activeBackend.target);
			activeBackend.promptReady = false;
			pi.appendEntry(STATE_ENTRY, serializeBackend(activeBackend));
			ctx?.ui?.notify?.("ShellGate helper functions cleaned from tmux pane.", "info");
			return `cleaned:${describeBackend(activeBackend)}`;
		}
		if (["off", "reset", "normal", "default"].includes(mode)) {
			setBackend(null, ctx);
			return describeBackend(null);
		}
		if (mode === "local") {
			const cwd = input.path || localCwd;
			if (cwd === localCwd) {
				setBackend(null, ctx);
				return describeBackend(null);
			}
			const backend: Backend = { kind: "local", cwd };
			await ensureDirectory(backend);
			setBackend(backend, ctx);
			return describeBackend(backend);
		}
		if (mode === "ssh") {
			if (!input.host) throw new Error("host is required for ssh mode");
			const cwd = await resolveSshCwd(input.host, input.path);
			const backend: Backend = { kind: "ssh", host: input.host, cwd };
			await ensureDirectory(backend);
			setBackend(backend, ctx);
			return describeBackend(backend);
		}
		if (mode === "tmux") {
			if (!input.target) throw new Error("target is required for tmux mode");
			const backend = await activateTmux(undefined, input.target, input.path, input.create ?? true);
			setBackend(backend, ctx);
			return describeBackend(backend);
		}
		if (mode === "ssh-tmux" || mode === "sshtmux" || mode === "remote-tmux") {
			if (!input.host) throw new Error("host is required for ssh-tmux mode");
			if (!input.target) throw new Error("target is required for ssh-tmux mode");
			const backend = await activateTmux(input.host, input.target, input.path, input.create ?? true);
			setBackend(backend, ctx);
			return describeBackend(backend);
		}
		throw new Error(`unknown ShellGate mode: ${input.mode}`);
	};

	const handleCommand = async (args: string, ctx: any) => {
		const parts = splitArgs(args.trim());
		if (parts.length === 0 || parts[0] === "help") {
			ctx.ui.notify(`${commandHelp()}\n\nCurrent: ${describeBackend(activeBackend)}`, "info");
			return;
		}
		const [mode, ...rest] = parts;
		if (mode === "status") {
			ctx.ui.notify(`ShellGate: ${describeBackend(activeBackend)}`, "info");
			return;
		}
		if (["clean", "cleanup"].includes(mode)) {
			if (activeBackend?.kind !== "tmux") {
				ctx.ui.notify("ShellGate clean is only needed for tmux backends.", "info");
				return;
			}
			await tmuxCleanPromptHelpers(activeBackend.host, activeBackend.target);
			activeBackend.promptReady = false;
			pi.appendEntry(STATE_ENTRY, serializeBackend(activeBackend));
			ctx.ui.notify("ShellGate helper functions cleaned from tmux pane.", "info");
			return;
		}
		if (["off", "reset", "normal", "default"].includes(mode)) {
			await connect({ mode }, ctx);
			return;
		}
		if (mode === "local") {
			await connect({ mode, path: rest[0] }, ctx);
			return;
		}
		if (mode === "ssh") {
			if (!rest[0]) throw new Error("Usage: /shellgate ssh host[:/path]");
			const parsed = parseHostPath(rest[0]);
			await connect({ mode, host: parsed.host, path: rest[1] || parsed.path }, ctx);
			return;
		}
		if (mode === "tmux") {
			if (!rest[0]) throw new Error("Usage: /shellgate tmux session [/path]");
			await connect({ mode, target: rest[0], path: rest[1] }, ctx);
			return;
		}
		if (["ssh-tmux", "sshtmux", "remote-tmux"].includes(mode)) {
			if (!rest[0] || !rest[1]) throw new Error("Usage: /shellgate ssh-tmux host session [/path]");
			await connect({ mode, host: rest[0], target: rest[1], path: rest[2] }, ctx);
			return;
		}
		const parsed = parseHostPath(mode);
		await connect({ mode: "ssh", host: parsed.host, path: rest[0] || parsed.path }, ctx);
	};

	pi.registerCommand("shellgate", {
		description: "Route bash/read/write/edit through local, SSH, tmux, or SSH tmux",
		handler: handleCommand,
	});

	pi.registerCommand("sg", {
		description: "Alias for /shellgate",
		handler: handleCommand,
	});

	pi.registerTool({
		name: "shellgate_connect",
		label: "ShellGate Connect",
		description:
			"Connect or switch ShellGate so subsequent bash/read/write/edit calls run on a local path, SSH host, local tmux session, remote SSH tmux session, or a tmux pane already attached to docker exec. Use status/off/local/ssh/tmux/ssh-tmux modes.",
		promptSnippet: "Switch bash/read/write/edit to local, SSH, tmux, or SSH tmux backends",
		promptGuidelines: [
			"Use shellgate_connect before doing work when the user says to ssh to a host, connect to tmux, use a remote machine, or continue work in a specified shell/tmux session.",
			"After shellgate_connect succeeds, use normal bash/read/write/edit tools without wrapping commands in ssh or tmux; ShellGate routes those tools transparently.",
			"When connecting to tmux, prefer a pane in the user's visible/current pi tmux session if the user is observing; do not silently create an unrelated session unless necessary or requested.",
			"When the user wants to work inside a Docker container, prefer using a user-visible tmux pane that is already running docker exec -it <container> bash/sh, or clearly create one in the visible/current session, then connect ShellGate to that pane so ordinary bash/read/write/edit run inside the container shell.",
			"When ShellGate is active, prefer bash for directory listing and search unless ls/grep/find have also been explicitly routed by another extension.",
			"In tmux backends, commands run in the pane shell; do not use direct exit/exec unless the user wants to close or replace the pane shell. Wrap exit-code tests in a subshell, e.g. ( exit 7 ) or bash -lc 'exit 7'.",
		],
		parameters: connectSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const status = await connect(params as { mode: string; host?: string; target?: string; path?: string; create?: boolean }, ctx as any);
			return {
				content: [{ type: "text", text: `ShellGate active backend: ${status}` }],
				details: { backend: serializeBackend(activeBackend) },
			};
		},
	});

	pi.registerTool({
		name: "shellgate_send",
		label: "ShellGate Send",
		description: "Send text or a key to the current ShellGate interactive program, such as pdb, after ShellGate reports that the target shell is waiting for input.",
		promptSnippet: "Send input to current ShellGate interactive state",
		promptGuidelines: [
			"Use shellgate_send only after ShellGate reports that the target shell is waiting for input in an interactive program such as pdb.",
			"Do not use bash/read/write/edit while ShellGate reports an interactive state; send debugger commands or keys with shellgate_send instead.",
			"For pdb, send commands like where, n, s, c, p variable, or q with enter=true.",
		],
		parameters: sendSchema,
		async execute(_toolCallId, params) {
			if (!activeBackend || activeBackend.kind !== "tmux") throw new Error("shellgate_send requires an active tmux ShellGate backend");
			const result = await sendTmuxInteractiveInput(activeBackend, params as { text?: string; key?: string; enter?: boolean });
			return {
				content: [{ type: "text", text: result.output || `(interactive state: ${result.state})` }],
				details: result,
			};
		},
	});

	pi.registerTool({
		...localBash,
		async execute(id, params, signal, onUpdate, ctx) {
			if (!activeBackend) return localBash.execute(id, params, signal, onUpdate, ctx);
			const tool = createBashTool(localCwd, { operations: createBashOps(activeBackend, localCwd) });
			return tool.execute(id, params, signal, onUpdate, ctx);
		},
	});

	pi.registerTool({
		...localRead,
		async execute(id, params, signal, onUpdate, ctx) {
			if (!activeBackend) return localRead.execute(id, params, signal, onUpdate, ctx);
			const tool = createReadTool(localCwd, { operations: createReadOps(activeBackend, localCwd) });
			return tool.execute(id, params, signal, onUpdate, ctx);
		},
	});

	pi.registerTool({
		...localWrite,
		async execute(id, params, signal, onUpdate, ctx) {
			if (!activeBackend) return localWrite.execute(id, params, signal, onUpdate, ctx);
			const tool = createWriteTool(localCwd, { operations: createWriteOps(activeBackend, localCwd) });
			return tool.execute(id, params, signal, onUpdate, ctx);
		},
	});

	pi.registerTool({
		...localEdit,
		async execute(id, params, signal, onUpdate, ctx) {
			if (!activeBackend) return localEdit.execute(id, params, signal, onUpdate, ctx);
			const tool = createEditTool(localCwd, { operations: createEditOps(activeBackend, localCwd) });
			return tool.execute(id, params, signal, onUpdate, ctx);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		activeBackend = null;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === STATE_ENTRY) {
				activeBackend = restoreBackend(entry.data);
			}
		}
		setStatus(ctx);
	});

	pi.on("user_bash", (_event, _ctx) => {
		if (!activeBackend) return;
		return { operations: createBashOps(activeBackend, localCwd) };
	});

	pi.on("before_agent_start", (event) => {
		const base = [
			"ShellGate extension is available.",
			"If the user asks to ssh to a host, connect to tmux, use a remote machine, or continue inside a named shell/tmux session, call shellgate_connect first.",
			"After ShellGate is active, do not wrap bash commands in ssh/tmux; use normal bash/read/write/edit and ShellGate will route them.",
			"ShellGate command forms for the user: /shellgate ssh host[:/path], /shellgate tmux session [/path], /shellgate ssh-tmux host session [/path], /shellgate off. Alias: /sg.",
			"Tmux visibility rule: if the user is watching, prefer the user's visible/current pi tmux session or pane; announce any new pane/session name before using it.",
			"Docker-through-tmux pattern: open or reuse a user-visible tmux pane running docker exec -it <container> bash/sh, connect ShellGate to that pane, then use normal bash/read/write/edit as if the container shell were native.",
		];
		if (activeBackend) {
			base.push(`Current ShellGate backend: ${describeBackend(activeBackend)}.`);
			base.push("Treat the ShellGate backend as the current working environment. Prefer bash for directory listing/search because bash/read/write/edit are the routed first-class tools.");
			return {
				systemPrompt: event.systemPrompt.replace(
					`Current working directory: ${localCwd}`,
					`Current working directory: ${activeBackend.cwd} (via ${describeBackend(activeBackend)})`,
				) + `\n\n${base.join("\n")}`,
			};
		}
		return { systemPrompt: `${event.systemPrompt}\n\n${base.join("\n")}` };
	});
}
