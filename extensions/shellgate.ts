import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

type ManagedBackend = {
	kind: "managed";
	host?: string;
	target: string;
	displayTarget?: string;
	cwd: string;
	socketPath: string;
};

type Backend = DirectBackend | ManagedBackend;

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
	display?: string;
	visibleOutput?: boolean;
	useCurrentShellCwd?: boolean;
};

const STATE_ENTRY = "shellgate-state";
const DEFAULT_CONNECT_TIMEOUT_SECONDS = 8;
const DEFAULT_COMMAND_TIMEOUT_SECONDS = 30;
const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));

const connectSchema = Type.Object({
	mode: Type.String({
		description: "Connection mode: status, off, local, ssh, tmux, ssh-tmux, tmux-managed, or ssh-tmux-managed. tmux modes use the broker-managed child-shell backend.",
	}),
	host: Type.Optional(Type.String({ description: "SSH host, for ssh or ssh-tmux modes" })),
	target: Type.Optional(Type.String({ description: "tmux session or target pane, for tmux modes" })),
	path: Type.Optional(Type.String({ description: "Working directory on the selected host/session" })),
	create: Type.Optional(Type.Boolean({ description: "Create tmux session when missing; defaults to true" })),
	adopt: Type.Optional(Type.Boolean({ description: "For tmux-managed modes, start the broker in an existing ordinary pane shell as a foreground program" })),
});

const inputSchema = Type.Object({
	text: Type.Optional(Type.String({ description: "Literal text to send to the managed child pty" })),
	key: Type.Optional(Type.String({ description: "Special key to send, such as C-c, C-d, Enter, Up, Down, Left, Right, Tab, Esc, or Backspace" })),
	enter: Type.Optional(Type.Boolean({ description: "Press Enter after text; defaults to true when text is provided" })),
	force: Type.Optional(Type.Boolean({ description: "Send even when the broker does not detect an interactive foreground program" })),
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

function parsePathFlags(args: string[]): { path?: string; adopt: boolean } {
	let adopt = false;
	let pathValue: string | undefined;
	for (const arg of args) {
		if (["--adopt", "adopt", "--foreground", "foreground"].includes(arg)) {
			adopt = true;
			continue;
		}
		if (pathValue === undefined) pathValue = arg;
	}
	return { path: pathValue, adopt };
}

function describeBackend(backend: Backend | null): string {
	if (!backend) return "normal local shell";
	if (backend.kind === "local") return `local:${backend.cwd}`;
	if (backend.kind === "ssh") return `ssh:${backend.host}:${backend.cwd}`;
	if (backend.kind === "managed") {
		const target = backend.displayTarget && backend.displayTarget !== backend.target ? `${backend.displayTarget} (${backend.target})` : backend.target;
		return backend.host ? `ssh-tmux-managed:${backend.host}:${target}:${backend.cwd}` : `tmux-managed:${target}:${backend.cwd}`;
	}
	return "unknown";
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

function safeTargetName(target: string): string {
	return target.replace(/[^A-Za-z0-9_.-]/g, "_");
}

function managedSocketPath(target: string): string {
	return `/tmp/shellgate-managed-${safeTargetName(target)}.sock`;
}

function managedLaunchScriptPath(target: string): string {
	return `/tmp/shellgate-launch-${safeTargetName(target)}.sh`;
}

function brokerPath(): string {
	return path.join(EXTENSION_DIR, "shellgate-broker.py");
}

async function tmuxTargetExists(host: string | undefined, target: string): Promise<boolean> {
	const result = await runHostRaw(host, `tmux display-message -p -t ${shellQuote(target)} '#{pane_id}'`, { timeout: DEFAULT_CONNECT_TIMEOUT_SECONDS });
	return result.code === 0 && result.stdout.toString().trim().startsWith("%");
}

async function tmuxPaneId(host: string | undefined, target: string): Promise<string> {
	return runHostChecked(host, `tmux display-message -p -t ${shellQuote(target)} '#{pane_id}'`, { timeout: DEFAULT_CONNECT_TIMEOUT_SECONDS }).then((value) => value.trim());
}

async function tmuxPaneCwd(host: string | undefined, target: string): Promise<string> {
	return runHostChecked(host, `tmux display-message -p -t ${shellQuote(target)} '#{pane_current_path}'`, { timeout: DEFAULT_CONNECT_TIMEOUT_SECONDS }).then((value) => value.trim());
}

async function managedBrokerCommand(host: string | undefined): Promise<string> {
	if (!host) return `python3 ${shellQuote(brokerPath())}`;
	const remotePath = "/tmp/shellgate-broker.py";
	await runHostChecked(host, `cat > ${shellQuote(remotePath)} && chmod 700 ${shellQuote(remotePath)}`, {
		input: readFileSync(brokerPath()),
		timeout: DEFAULT_CONNECT_TIMEOUT_SECONDS,
	});
	return `python3 ${shellQuote(remotePath)}`;
}

type ManagedPing = {
	ok?: boolean;
	broker?: string;
	cwd?: string;
	child_pid?: number;
	capabilities?: string[];
};

function isSimpleTmuxSession(target: string): boolean {
	return /^[A-Za-z0-9_.-]+$/.test(target);
}

async function tmuxPaneCommandLine(host: string | undefined, target: string): Promise<string> {
	const pid = await runHostChecked(host, `tmux display-message -p -t ${shellQuote(target)} '#{pane_pid}'`, { timeout: DEFAULT_CONNECT_TIMEOUT_SECONDS })
		.then((value) => value.trim())
		.catch(() => "");
	if (!/^\d+$/.test(pid)) return "";
	const script = `python3 - ${shellQuote(pid)} <<'PY'\nimport sys\npid = sys.argv[1]\ntry:\n    data = open(f"/proc/{pid}/cmdline", "rb").read().replace(b"\\0", b" ").decode(errors="replace").strip()\n    print(data)\nexcept Exception:\n    pass\nPY`;
	return runHostChecked(host, script, { timeout: DEFAULT_CONNECT_TIMEOUT_SECONDS }).then((value) => value.trim()).catch(() => "");
}

function isManagedBrokerCommandLine(commandLine: string): boolean {
	return commandLine.includes("shellgate-broker.py");
}

function isLegacyManagedCommandLine(commandLine: string): boolean {
	return commandLine.includes("tail") && commandLine.includes("/tmp/shellgate-managed-") && commandLine.includes(".log");
}

function managedSocketPathFromCommandLine(commandLine: string): string | undefined {
	const parts = commandLine.split(/\s+/);
	const index = parts.indexOf("--socket");
	return index >= 0 && parts[index + 1] ? parts[index + 1] : undefined;
}

async function managedSocketRequestToPath(host: string | undefined, socketPath: string, request: string, timeout: number): Promise<Buffer> {
	const clientScript = `import socket,sys\np=sys.argv[1]\ns=socket.socket(socket.AF_UNIX)\ns.connect(p)\ns.sendall(sys.stdin.buffer.read())\nb=b''\nwhile not b.endswith(b'\\n'):\n    chunk=s.recv(65536)\n    if not chunk: break\n    b+=chunk\nsys.stdout.buffer.write(b)\n`;
	const result = await runHostRaw(host, `python3 -c ${shellQuote(clientScript)} ${shellQuote(socketPath)}`, {
		input: request,
		timeout,
	});
	if (result.code !== 0) {
		throw new Error(Buffer.concat([result.stdout, result.stderr]).toString().trim() || `managed socket client exited ${result.code}`);
	}
	return result.stdout;
}

async function managedBrokerPing(host: string | undefined, socketPath: string): Promise<ManagedPing | undefined> {
	try {
		const raw = await managedSocketRequestToPath(host, socketPath, `${JSON.stringify({ action: "ping" })}\n`, 2);
		const response = JSON.parse(raw.toString().trim() || "{}");
		return response.ok && response.broker === "shellgate" ? response : undefined;
	} catch {
		return undefined;
	}
}

function managedBrokerHasCapability(ping: ManagedPing | undefined, capability: string): boolean {
	return Array.isArray(ping?.capabilities) && ping.capabilities.includes(capability);
}

async function shutdownManagedBackend(backend: ManagedBackend): Promise<void> {
	await managedSocketRequestToPath(backend.host, backend.socketPath, `${JSON.stringify({ action: "shutdown" })}\n`, 2).catch(() => Buffer.alloc(0));
}

async function waitForManagedBroker(host: string | undefined, socketPath: string): Promise<ManagedPing> {
	const deadline = Date.now() + DEFAULT_CONNECT_TIMEOUT_SECONDS * 1000;
	while (Date.now() < deadline) {
		const ping = await managedBrokerPing(host, socketPath);
		if (ping) return ping;
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	throw new Error(`managed broker socket not ready: ${socketPath}`);
}

async function managedBrokerLaunchCommand(host: string | undefined, cwd: string, socketPath: string, history = "off"): Promise<string> {
	const broker = await managedBrokerCommand(host);
	const shellPath = host ? await runHostChecked(host, `printf %s \"\${SHELL:-/bin/sh}\"`, { timeout: DEFAULT_CONNECT_TIMEOUT_SECONDS }).then((value) => value.trim()) : process.env.SHELL || "/bin/sh";
	return `${broker} --socket ${shellQuote(socketPath)} --cwd ${shellQuote(cwd)} --shell ${shellQuote(shellPath)} --history ${shellQuote(history)}`;
}

async function startManagedBroker(host: string | undefined, target: string, cwd: string, socketPath: string): Promise<void> {
	if (!isSimpleTmuxSession(target)) throw new Error(`tmux target ${target} cannot be auto-created; use a simple session name`);
	const command = await managedBrokerLaunchCommand(host, cwd, socketPath);
	await runHostChecked(host, `rm -f ${shellQuote(socketPath)}; tmux new-session -d -s ${shellQuote(target)} -c ${shellQuote(cwd)} ${shellQuote(command)}`, { timeout: DEFAULT_CONNECT_TIMEOUT_SECONDS });
}

async function adoptManagedBroker(host: string | undefined, target: string, cwd: string, socketPath: string): Promise<void> {
	const broker = await managedBrokerCommand(host);
	const launchPath = managedLaunchScriptPath(target);
	const launchScript = `#!/bin/sh\nexec ${broker} --socket ${shellQuote(socketPath)} --cwd ${shellQuote(cwd)} --shell "\${SHELL:-/bin/sh}" --history off\n`;
	await runHostChecked(host, `cat > ${shellQuote(launchPath)} && chmod 700 ${shellQuote(launchPath)}`, {
		input: launchScript,
		timeout: DEFAULT_CONNECT_TIMEOUT_SECONDS,
	});
	await runHostChecked(host, `rm -f ${shellQuote(socketPath)}; tmux send-keys -t ${shellQuote(target)} C-c; tmux send-keys -t ${shellQuote(target)} -l ${shellQuote(launchPath)}; tmux send-keys -t ${shellQuote(target)} Enter`, { timeout: DEFAULT_CONNECT_TIMEOUT_SECONDS });
}

async function respawnManagedBroker(host: string | undefined, target: string, cwd: string, socketPath: string): Promise<void> {
	const command = await managedBrokerLaunchCommand(host, cwd, socketPath);
	await runHostChecked(host, `rm -f ${shellQuote(socketPath)}; tmux respawn-pane -k -t ${shellQuote(target)} -c ${shellQuote(cwd)} ${shellQuote(command)}`, { timeout: DEFAULT_CONNECT_TIMEOUT_SECONDS });
}

async function replaceManagedBroker(host: string | undefined, target: string, stableTarget: string, cwd: string, _oldSocketPath: string, socketPath: string, _create: boolean): Promise<ManagedPing> {
	await respawnManagedBroker(host, stableTarget, cwd, socketPath);
	return waitForManagedBroker(host, socketPath);
}

async function activateManagedTmux(host: string | undefined, target: string, pathValue: string | undefined, create: boolean, adopt: boolean): Promise<ManagedBackend> {
	let cwd = pathValue || (host ? await resolveSshCwd(host) : process.cwd());
	const displayTarget = target;
	const socketPath = managedSocketPath(target);
	let exists = await tmuxTargetExists(host, target);
	if (exists) {
		const stableTarget = await tmuxPaneId(host, target);
		const directPing = await managedBrokerPing(host, socketPath);
		if (directPing) {
			if (adopt && !managedBrokerHasCapability(directPing, "input-delta")) {
				const ping = await replaceManagedBroker(host, target, stableTarget, cwd, socketPath, socketPath, create);
				cwd = typeof ping.cwd === "string" ? ping.cwd : cwd;
				return { kind: "managed", host, target: stableTarget, displayTarget, cwd, socketPath };
			}
			cwd = typeof directPing.cwd === "string" ? directPing.cwd : cwd;
			return { kind: "managed", host, target: stableTarget, displayTarget, cwd, socketPath };
		}
		const commandLine = await tmuxPaneCommandLine(host, stableTarget);
		if (isManagedBrokerCommandLine(commandLine)) {
			const existingSocketPath = managedSocketPathFromCommandLine(commandLine) || socketPath;
			try {
				const ping = await waitForManagedBroker(host, existingSocketPath);
				if (adopt && !managedBrokerHasCapability(ping, "input-delta")) {
					const replacement = await replaceManagedBroker(host, target, stableTarget, cwd, existingSocketPath, socketPath, create);
					cwd = typeof replacement.cwd === "string" ? replacement.cwd : cwd;
					return { kind: "managed", host, target: stableTarget, displayTarget, cwd, socketPath };
				}
				cwd = typeof ping.cwd === "string" ? ping.cwd : await tmuxPaneCwd(host, stableTarget).catch(() => cwd);
				return { kind: "managed", host, target: stableTarget, displayTarget, cwd, socketPath: existingSocketPath };
			} catch (error) {
				if (!create || !isSimpleTmuxSession(target)) throw error;
				await runHostRaw(host, `tmux kill-session -t ${shellQuote(target)}; rm -f ${shellQuote(socketPath)}`, { timeout: DEFAULT_CONNECT_TIMEOUT_SECONDS });
				exists = false;
			}
		} else if (isLegacyManagedCommandLine(commandLine) && create && isSimpleTmuxSession(target)) {
			await runHostRaw(host, `tmux kill-session -t ${shellQuote(target)}; rm -f ${shellQuote(socketPath)}`, { timeout: DEFAULT_CONNECT_TIMEOUT_SECONDS });
			exists = false;
		} else if (adopt) {
			await adoptManagedBroker(host, stableTarget, cwd, socketPath);
			const ping = await waitForManagedBroker(host, socketPath);
			cwd = typeof ping.cwd === "string" ? ping.cwd : cwd;
			return { kind: "managed", host, target: stableTarget, displayTarget, cwd, socketPath };
		} else {
			throw new Error(`tmux target exists but is not a ShellGate managed broker: ${target}${commandLine ? ` (${commandLine})` : ""}; pass adopt=true to start the broker in this existing pane foreground`);
		}
	}
	if (!exists) {
		if (!create) throw new Error(`tmux target not found: ${target}`);
		await startManagedBroker(host, target, cwd, socketPath);
	}
	const stableTarget = await tmuxPaneId(host, target);
	const ping = await waitForManagedBroker(host, socketPath);
	cwd = typeof ping.cwd === "string" ? ping.cwd : await tmuxPaneCwd(host, stableTarget).catch(() => cwd);
	return { kind: "managed", host, target: stableTarget, displayTarget, cwd, socketPath };
}

async function managedSocketRequest(backend: ManagedBackend, request: string): Promise<Buffer> {
	return managedSocketRequestToPath(backend.host, backend.socketPath, request, optionsTimeoutFromRequest(request));
}

type ManagedInputResult = Record<string, unknown> & {
	stdout?: string;
};

async function sendManagedInput(backend: ManagedBackend, input: { text?: string; key?: string; enter?: boolean; force?: boolean }): Promise<ManagedInputResult> {
	const rawResponse = await managedSocketRequestToPath(backend.host, backend.socketPath, `${JSON.stringify({ action: "input", ...input })}\n`, DEFAULT_COMMAND_TIMEOUT_SECONDS);
	const response = JSON.parse(rawResponse.toString().trim() || "{}");
	if (!response.ok) throw new Error(response.error || "managed input failed");
	if (typeof response.stdout_b64 === "string") {
		response.stdout = Buffer.from(response.stdout_b64, "base64").toString();
	}
	delete response.stdout_b64;
	return response;
}

function managedInputMessage(backend: ManagedBackend, result: ManagedInputResult): string {
	const state = typeof result.state === "string" ? result.state : "sent";
	const header = `input ${state} on ${describeBackend(backend)}`;
	const stdout = typeof result.stdout === "string" ? result.stdout : "";
	return stdout ? `${header}\n${stdout}` : header;
}

function optionsTimeoutFromRequest(request: string): number {
	try {
		const parsed = JSON.parse(request);
		return typeof parsed.timeout === "number" && parsed.timeout > 0 ? parsed.timeout + 2 : DEFAULT_COMMAND_TIMEOUT_SECONDS;
	} catch {
		return DEFAULT_COMMAND_TIMEOUT_SECONDS;
	}
}

async function runManagedBackend(
	backend: ManagedBackend,
	command: string,
	cwd: string,
	options: CommandOptions = {},
): Promise<RawResult> {
	const targetCwd = options.useCurrentShellCwd ? undefined : mapPath(cwd, process.cwd(), backend);
	const id = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
	const payload: Record<string, unknown> = { id, command, timeout: options.timeout, display: options.display, visible_output: options.visibleOutput !== false };
	if (targetCwd) payload.cwd = targetCwd;
	const request = `${JSON.stringify(payload)}\n`;
	const rawResponse = await managedSocketRequest(backend, request);
	const response = JSON.parse(rawResponse.toString().trim() || "{}");
	const out = Buffer.from(response.stdout_b64 || "", "base64");
	const err = Buffer.from(response.stderr_b64 || "", "base64");
	backend.cwd = response.cwd || backend.cwd;
	if (out.length) options.onStdout?.(out);
	if (err.length) options.onStderr?.(err);
	if (!response.ok) throw new Error(response.error || "managed command failed");
	return { code: response.code, stdout: out, stderr: err, killed: false };
}

async function runBackend(backend: Backend, command: string, cwd: string, options: CommandOptions = {}): Promise<RawResult> {
	if (backend.kind === "managed") return runManagedBackend(backend, command, cwd, options);
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
				display: `read ${target}`,
				visibleOutput: false,
			});
			return Buffer.from(output.replace(/\s/g, ""), "base64");
		},
		async access(path) {
			const target = mapPath(path, localCwd, backend);
			await backendOutput(backend, `test -r ${shellQuote(target)}`, backend.cwd, {
				timeout: DEFAULT_COMMAND_TIMEOUT_SECONDS,
				display: `access ${target}`,
				visibleOutput: false,
			});
		},
		async detectImageMimeType(path) {
			const target = mapPath(path, localCwd, backend);
			try {
				const mime = await backendOutput(backend, `file --mime-type -b ${shellQuote(target)}`, backend.cwd, {
					timeout: DEFAULT_COMMAND_TIMEOUT_SECONDS,
					display: `mime ${target}`,
					visibleOutput: false,
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
				{ timeout: DEFAULT_COMMAND_TIMEOUT_SECONDS, display: `write ${target} (${Buffer.from(content).length} bytes)`, visibleOutput: false },
			);
		},
		async mkdir(dir) {
			const target = mapPath(dir, localCwd, backend);
			await backendOutput(backend, `mkdir -p ${shellQuote(target)}`, backend.cwd, {
				timeout: DEFAULT_COMMAND_TIMEOUT_SECONDS,
				display: `mkdir -p ${target}`,
				visibleOutput: false,
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
				display: `access rw ${target}`,
				visibleOutput: false,
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
				useCurrentShellCwd: backend.kind === "managed" && !cwd,
			});
			return { exitCode: result.code };
		},
	};
}

async function ensureDirectory(backend: Backend): Promise<void> {
	await backendOutput(backend, `test -d ${shellQuote(backend.cwd)}`, backend.cwd, {
		timeout: DEFAULT_CONNECT_TIMEOUT_SECONDS,
		display: `ensure-directory ${backend.cwd}`,
		visibleOutput: false,
	});
}

async function resolveSshCwd(host: string, path?: string): Promise<string> {
	if (path) return path;
	return runHostChecked(host, "pwd", { timeout: DEFAULT_CONNECT_TIMEOUT_SECONDS }).then((value) => value.trim());
}


function serializeBackend(backend: Backend | null): Record<string, unknown> {
	if (!backend) return { kind: "off" };
	if (backend.kind === "managed") {
		return {
			kind: backend.kind,
			host: backend.host,
			target: backend.target,
			displayTarget: backend.displayTarget,
			cwd: backend.cwd,
			socketPath: backend.socketPath,
		};
	}
	return { ...backend };
}

function restoreBackend(data: unknown): Backend | null {
	if (!data || typeof data !== "object") return null;
	const value = data as Record<string, unknown>;
	if (value.kind === "local" && typeof value.cwd === "string") return { kind: "local", cwd: value.cwd };
	if (value.kind === "ssh" && typeof value.host === "string" && typeof value.cwd === "string") {
		return { kind: "ssh", host: value.host, cwd: value.cwd };
	}
	if (value.kind === "managed" && typeof value.target === "string" && typeof value.cwd === "string" && typeof value.socketPath === "string") {
		return {
			kind: "managed",
			host: typeof value.host === "string" ? value.host : undefined,
			target: value.target,
			displayTarget: typeof value.displayTarget === "string" ? value.displayTarget : undefined,
			cwd: value.cwd,
			socketPath: value.socketPath,
		};
	}
	if (value.kind === "tmux") return null;
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
		"  /shellgate tmux session [/path] [--adopt]",
		"  /shellgate ssh-tmux host session [/path] [--adopt]",
		"  /shellgate tmux-managed session [/path] [--adopt]",
		"  /shellgate ssh-tmux-managed host session [/path] [--adopt]",
		"Tmux modes start or reuse a broker-managed child shell in a tmux pane; user and agent cowork in that managed shell, not the original parent shell.",
		"Use --adopt only when you intentionally want to start the broker as the foreground program in an existing ordinary pane.",
		"For an existing visible pane, pass --adopt only when you intentionally want the broker to become that pane's foreground program.",
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
		input: { mode: string; host?: string; target?: string; path?: string; create?: boolean; adopt?: boolean },
		ctx?: { ui?: { setStatus?: (key: string, value?: string) => void; theme?: { fg: (name: string, text: string) => string }; notify?: (message: string, type?: "info" | "warning" | "error") => void } },
	): Promise<string> => {
		const mode = input.mode.toLowerCase();
		if (mode === "status") return describeBackend(activeBackend);
		if (["clean", "cleanup"].includes(mode)) return "ShellGate broker mode has no helper cleanup step";
		if (["off", "reset", "normal", "default"].includes(mode)) {
			const previous = activeBackend;
			if (previous?.kind === "managed") await shutdownManagedBackend(previous);
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
		if (["tmux", "tmux-managed", "managed-tmux"].includes(mode)) {
			if (!input.target) throw new Error("target is required for tmux-managed mode");
			const backend = await activateManagedTmux(undefined, input.target, input.path, input.create ?? true, input.adopt ?? false);
			setBackend(backend, ctx);
			return describeBackend(backend);
		}
		if (["ssh-tmux", "sshtmux", "remote-tmux", "ssh-tmux-managed", "sshtmux-managed", "remote-tmux-managed"].includes(mode)) {
			if (!input.host) throw new Error("host is required for ssh-tmux-managed mode");
			if (!input.target) throw new Error("target is required for ssh-tmux-managed mode");
			const backend = await activateManagedTmux(input.host, input.target, input.path, input.create ?? true, input.adopt ?? false);
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
			ctx.ui.notify("ShellGate broker mode has no helper cleanup step.", "info");
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
		if (["tmux", "tmux-managed", "managed-tmux"].includes(mode)) {
			if (!rest[0]) throw new Error("Usage: /shellgate tmux session [/path] [--adopt]");
			const parsed = parsePathFlags(rest.slice(1));
			await connect({ mode, target: rest[0], path: parsed.path, adopt: parsed.adopt }, ctx);
			return;
		}
		if (["ssh-tmux", "sshtmux", "remote-tmux", "ssh-tmux-managed", "sshtmux-managed", "remote-tmux-managed"].includes(mode)) {
			if (!rest[0] || !rest[1]) throw new Error("Usage: /shellgate ssh-tmux host session [/path] [--adopt]");
			const parsed = parsePathFlags(rest.slice(2));
			await connect({ mode, host: rest[0], target: rest[1], path: parsed.path, adopt: parsed.adopt }, ctx);
			return;
		}
		const parsed = parseHostPath(mode);
		await connect({ mode: "ssh", host: parsed.host, path: rest[0] || parsed.path }, ctx);
	};

	pi.registerCommand("shellgate", {
		description: "Route bash/read/write/edit through local, SSH, or broker-managed tmux",
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
			"Connect or switch ShellGate so subsequent bash/read/write/edit calls run on a local path, SSH host, or broker-managed tmux child shell. Use status/off/local/ssh/tmux/ssh-tmux/tmux-managed/ssh-tmux-managed modes. All tmux modes use the broker-managed backend. adopt=true intentionally starts the broker in an existing ordinary pane.",
		promptSnippet: "Switch bash/read/write/edit to local, SSH, or broker-managed tmux backends",
		promptGuidelines: [
			"Use shellgate_connect before doing work when the user says to ssh to a host, connect to tmux, use a remote machine, or continue work in a specified shell/tmux session.",
			"After shellgate_connect succeeds, use normal bash/read/write/edit tools without wrapping commands in ssh or tmux; ShellGate routes those tools transparently.",
			"Use tmux modes for cowork in a ShellGate-managed child shell: the pane foreground is a broker managing a child shell, and both user keystrokes and agent commands go to that managed shell.",
			"Use shellgate_input to send explicit interactive input to the broker-managed child pty, for example pdb commands, without using tmux send-keys or attach helpers.",
			"For an existing ordinary tmux pane, use tmux-managed with adopt=true only when the user explicitly wants the broker to become that pane's foreground program.",
			"tmux-managed is not the user's original parent shell; it inherits cwd/exported environment but not aliases, functions, unexported variables, jobs, or shell options.",
			"When ShellGate is active, prefer bash for directory listing and search unless ls/grep/find have also been explicitly routed by another extension.",
		],
		parameters: connectSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const status = await connect(params as { mode: string; host?: string; target?: string; path?: string; create?: boolean; adopt?: boolean }, ctx as any);
			return {
				content: [{ type: "text", text: `ShellGate active backend: ${status}` }],
				details: { backend: serializeBackend(activeBackend) },
			};
		},
	});

	pi.registerTool({
		name: "shellgate_input",
		label: "ShellGate Input",
		description: "Send explicit interactive input to the active broker-managed child pty, such as pdb commands. This uses the ShellGate broker socket, not tmux send-keys or attach helpers.",
		promptSnippet: "Send input to the active ShellGate broker-managed child pty",
		promptGuidelines: [
			"Use shellgate_input only with an active broker-managed tmux backend.",
			"Use it for explicit interactive programs running in the managed child pty, such as pdb, Python input(), or REPL prompts.",
			"Do not use tmux send-keys for ShellGate-managed interactive input.",
			"For pdb, send commands like where, n, s, c, p variable, or q with enter=true.",
		],
		parameters: inputSchema,
		async execute(_toolCallId, params) {
			if (!activeBackend || activeBackend.kind !== "managed") throw new Error("shellgate_input requires an active broker-managed ShellGate backend");
			const result = await sendManagedInput(activeBackend, params as { text?: string; key?: string; enter?: boolean; force?: boolean });
			return {
				content: [{ type: "text", text: managedInputMessage(activeBackend, result) }],
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
			"ShellGate command forms for the user: /shellgate ssh host[:/path], /shellgate tmux session [/path] [--adopt], /shellgate ssh-tmux host session [/path] [--adopt], /shellgate tmux-managed session [/path] [--adopt], /shellgate ssh-tmux-managed host session [/path] [--adopt], /shellgate off. Alias: /sg.",
			"All tmux modes use a broker-managed child shell. There is no tmux attach backend and no ShellGate command protocol should be injected into the user's original pane shell.",
			"Use shellgate_input for explicit interactive input to programs running in the broker-managed child pty; do not use tmux send-keys for this.",
			"Use adopt=true/--adopt only for explicit foreground broker adoption of an existing pane. The original pane shell is only the broker launcher; user and agent then cowork in the broker-managed child shell.",
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
