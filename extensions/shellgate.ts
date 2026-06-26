import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
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

type DirectBackend = {
	kind: "local" | "ssh";
	host?: string;
	cwd: string;
};

type TmuxBackend = {
	kind: "tmux";
	host?: string;
	target: string;
	displayTarget?: string;
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
const TMUX_CAPTURE_START = "-100000";

const connectSchema = Type.Object({
	mode: Type.String({
		description: "Connection mode: status, off, local, ssh, tmux, or ssh-tmux",
	}),
	host: Type.Optional(Type.String({ description: "SSH host, for ssh or ssh-tmux modes" })),
	target: Type.Optional(Type.String({ description: "tmux session or target pane, for tmux modes" })),
	path: Type.Optional(Type.String({ description: "Working directory on the selected host/session" })),
	create: Type.Optional(Type.Boolean({ description: "Create tmux session when missing; defaults to true" })),
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

function isSimpleTmuxSession(target: string): boolean {
	return /^[A-Za-z0-9_.-]+$/.test(target);
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

async function tmuxCommand(host: string | undefined, command: string, options: CommandOptions = {}): Promise<string> {
	return runHostChecked(host, command, options);
}

async function tmuxTargetExists(host: string | undefined, target: string): Promise<boolean> {
	const result = await runHostRaw(host, `tmux display-message -p -t ${shellQuote(target)} '#{pane_id}'`);
	return result.code === 0 && result.stdout.toString().trim().startsWith("%");
}

async function tmuxCapture(host: string | undefined, target: string): Promise<string> {
	return tmuxCommand(host, `tmux capture-pane -p -S ${TMUX_CAPTURE_START} -t ${shellQuote(target)}`);
}

async function tmuxPaneCwd(host: string | undefined, target: string): Promise<string> {
	return tmuxCommand(host, `tmux display-message -p -t ${shellQuote(target)} '#{pane_current_path}'`).then((value) =>
		value.trim(),
	);
}

async function tmuxPaneId(host: string | undefined, target: string): Promise<string> {
	return tmuxCommand(host, `tmux display-message -p -t ${shellQuote(target)} '#{pane_id}'`).then((value) =>
		value.trim(),
	);
}

async function tmuxSendLiteral(host: string | undefined, target: string, literal: string): Promise<void> {
	await tmuxCommand(host, `tmux send-keys -t ${shellQuote(target)} -l ${shellQuote(literal)}`);
	await tmuxCommand(host, `tmux send-keys -t ${shellQuote(target)} Enter`);
}

async function tmuxWriteTempScript(host: string | undefined, script: string, id: string): Promise<string> {
	const remotePath = `/tmp/shellgate-${id}.sh`;
	const encoded = Buffer.from(script).toString("base64");
	await runHostChecked(
		host,
		`umask 077; base64 -d > ${shellQuote(remotePath)} <<'__SHELLGATE_SCRIPT__'\n${encoded}\n__SHELLGATE_SCRIPT__\nchmod 700 ${shellQuote(remotePath)}`,
	);
	return remotePath;
}

async function tmuxRemoveTempScript(host: string | undefined, remotePath: string): Promise<void> {
	await runHostChecked(host, `rm -f ${shellQuote(remotePath)}`).catch(() => undefined);
}

async function tmuxRemoveStaleScripts(host: string | undefined): Promise<void> {
	await runHostChecked(host, "find /tmp -maxdepth 1 -type f -name 'shellgate-*.sh' -mmin +10 -delete").catch(() => undefined);
}

async function tmuxPasteText(host: string | undefined, target: string, text: string, id: string): Promise<void> {
	const bufferName = `shellgate_${id.replace(/-/g, "_")}`;
	await runHostChecked(host, `tmux load-buffer -b ${shellQuote(bufferName)} -`, { input: text });
	await tmuxCommand(host, `tmux paste-buffer -d -b ${shellQuote(bufferName)} -t ${shellQuote(target)}`);
	await tmuxCommand(host, `tmux send-keys -t ${shellQuote(target)} Enter`);
}

async function tmuxRunScriptInPane(host: string | undefined, target: string, script: string, id: string): Promise<void> {
	const paneScriptPath = `/tmp/shellgate-${id}.sh`;
	const delimiter = `__SHELLGATE_SCRIPT_${id}__`;
	const encoded = Buffer.from(script).toString("base64");
	const runner = [
		"(",
		"umask 077",
		`base64 -d > ${shellQuote(paneScriptPath)} <<'${delimiter}'`,
		encoded,
		delimiter,
		`chmod 700 ${shellQuote(paneScriptPath)}`,
		`"\${SHELL:-/bin/sh}" ${shellQuote(paneScriptPath)}`,
		")",
	].join("\n");
	await tmuxPasteText(host, target, runner, id);
}

let tmuxQueue: Promise<void> = Promise.resolve();

function enqueueTmux<T>(task: () => Promise<T>): Promise<T> {
	const next = tmuxQueue.then(task, task);
	tmuxQueue = next.then(
		() => undefined,
		() => undefined,
	);
	return next;
}

async function runTmuxBackend(
	backend: TmuxBackend,
	command: string,
	_optionsCwd: string,
	options: CommandOptions = {},
): Promise<RawResult> {
	return enqueueTmux(async () => {
		const id = randomUUID().replace(/-/g, "");
		const begin = `__SHELLGATE_BEGIN_${id}__`;
		const endPrefix = `__SHELLGATE_END_${id}__:`;
		const script = `__shellgate_finish() {\n\t__shellgate_status=$?\n\t__shellgate_cwd=$(pwd -P 2>/dev/null || pwd)\n\t__shellgate_cwd_b64=$(printf '%s' "$__shellgate_cwd" | base64 | tr -d '\\n')\n\tprintf '\\n${endPrefix}%s:%s\\n' "$__shellgate_status" "$__shellgate_cwd_b64"\n\trm -f "$0" 2>/dev/null || true\n\tstty echo 2>/dev/null || true\n}\ntrap __shellgate_finish EXIT\nprintf '\\n${begin}\\n'\n${command}\n`;

		await tmuxSendLiteral(backend.host, backend.target, "stty -echo");
		await new Promise((resolve) => setTimeout(resolve, 120));
		await tmuxRunScriptInPane(backend.host, backend.target, script, id);

		const cleanup = async () => {
			await tmuxCommand(backend.host, `tmux send-keys -t ${shellQuote(backend.target)} C-c`).catch(() => undefined);
			await tmuxSendLiteral(backend.host, backend.target, "stty echo").catch(() => undefined);
		};

		return new Promise<RawResult>((resolve, reject) => {
			let lastOutput = "";
			let settled = false;

			const settle = (fn: () => void) => {
				if (settled) return;
				settled = true;
				clearInterval(interval);
				if (timer) clearTimeout(timer);
				options.signal?.removeEventListener("abort", onAbort);
				fn();
			};

			const finishFromCapture = async (capture: string) => {
				const normalized = capture.replace(/\r/g, "");
				const beginIndex = normalized.lastIndexOf(begin);
				if (beginIndex === -1) return;
				const outputStart = beginIndex + begin.length;
				const endIndex = normalized.indexOf(endPrefix, outputStart);
				if (endIndex === -1) {
					const partial = normalized.slice(outputStart).replace(/^\n/, "");
					if (partial.length > lastOutput.length) {
						const delta = partial.slice(lastOutput.length);
						lastOutput = partial;
						options.onStdout?.(Buffer.from(delta));
					}
					return;
				}
				let output = normalized.slice(outputStart, endIndex).replace(/^\n/, "");
				if (output.endsWith("\n")) output = output.slice(0, -1);
				if (output.length > lastOutput.length) {
					options.onStdout?.(Buffer.from(output.slice(lastOutput.length)));
				}
				const statusLine = normalized.slice(endIndex + endPrefix.length).split("\n", 1)[0]?.trim() ?? "1";
				const [statusText, cwdB64] = statusLine.split(":", 2);
				const status = Number.parseInt(statusText ?? "1", 10);
				if (cwdB64) {
					backend.cwd = Buffer.from(cwdB64, "base64").toString() || backend.cwd;
					await tmuxSendLiteral(backend.host, backend.target, `cd ${shellQuote(backend.cwd)}`).catch(() => undefined);
				} else {
					backend.cwd = await tmuxPaneCwd(backend.host, backend.target).catch(() => backend.cwd);
				}
				settle(() =>
					resolve({
						code: Number.isFinite(status) ? status : 1,
						stdout: Buffer.from(output),
						stderr: Buffer.alloc(0),
						killed: false,
					}),
				);
			};

			const poll = () => {
				tmuxCapture(backend.host, backend.target)
					.then(finishFromCapture)
					.catch((error) => settle(() => reject(error)));
			};

			const onAbort = () => {
				cleanup().finally(() => settle(() => reject(new Error("aborted"))));
			};

			const interval = setInterval(poll, 250);
			const timer = options.timeout
				? setTimeout(() => {
					cleanup().finally(() => settle(() => reject(new Error(`timeout:${options.timeout}`))));
				}, options.timeout * 1000)
				: undefined;

			options.signal?.addEventListener("abort", onAbort, { once: true });
			poll();
		});
	});
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

async function activateTmux(host: string | undefined, target: string, path: string | undefined, create: boolean): Promise<TmuxBackend> {
	let cwd = path;
	const displayTarget = target;
	await tmuxRemoveStaleScripts(host);
	const exists = await tmuxTargetExists(host, target);
	if (!exists) {
		if (!create) throw new Error(`tmux target not found: ${target}`);
		if (!isSimpleTmuxSession(target)) {
			throw new Error(`tmux target ${target} cannot be auto-created; use a simple session name`);
		}
		if (!cwd) cwd = host ? await resolveSshCwd(host) : process.cwd();
		await tmuxCommand(host, `tmux new-session -d -s ${shellQuote(target)} -c ${shellQuote(cwd)}`);
	}
	const stableTarget = await tmuxPaneId(host, target);
	if (cwd) {
		await tmuxSendLiteral(host, stableTarget, `cd ${shellQuote(cwd)}`);
		await new Promise((resolve) => setTimeout(resolve, 150));
	} else {
		cwd = await tmuxPaneCwd(host, stableTarget);
	}
	await tmuxCommand(host, `tmux set-option -t ${shellQuote(target)} history-limit 100000`).catch(() => undefined);
	const backend: TmuxBackend = {
		kind: "tmux",
		host,
		target: stableTarget,
		displayTarget,
		cwd: cwd || (await tmuxPaneCwd(host, stableTarget)),
	};
	return backend;
}

function serializeBackend(backend: Backend | null): Record<string, unknown> {
	return backend ? { ...backend } : { kind: "off" };
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
