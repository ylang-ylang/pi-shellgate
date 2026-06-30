import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	buildShellgateHelperScript,
	extractPromptModeOutput,
	isShellgateDebugEnabled,
	shellgateHideRowsCommand,
	SHELLGATE_CLEAN_FUNCTION,
	SHELLGATE_HIDE_FUNCTION,
	SHELLGATE_OFF_FUNCTION,
	SHELLGATE_ON_FUNCTION,
	SHELLGATE_PROMPT,
	SHELLGATE_STATUS_FUNCTION,
} from "./tmux-helpers.ts";

export type TmuxInteractiveState = {
	statusId: string;
	captureStart?: TmuxPanePosition;
	lastOutput: string;
	process: TmuxProcessWaitState;
};

export type TmuxBackend = {
	kind: "tmux";
	host?: string;
	target: string;
	displayTarget?: string;
	cwd: string;
	promptReady?: boolean;
	promptActive?: boolean;
	interactive?: TmuxInteractiveState;
};

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

const DEFAULT_CONNECT_TIMEOUT_SECONDS = 8;

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\''`)}'`;
}

function isSimpleTmuxSession(target: string): boolean {
	return /^[A-Za-z0-9_.-]+$/.test(target);
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

function mapPath(path: string, localCwd: string, backend: TmuxBackend): string {
	if (!path.startsWith(localCwd)) return path;
	const suffix = path.slice(localCwd.length);
	return `${backend.cwd}${suffix}`;
}

async function resolveSshCwd(host: string, path?: string): Promise<string> {
	if (path) return path;
	return runHostChecked(host, "pwd", { timeout: DEFAULT_CONNECT_TIMEOUT_SECONDS }).then((value) => value.trim());
}

async function tmuxCommand(host: string | undefined, command: string, options: CommandOptions = {}): Promise<string> {
	return runHostChecked(host, command, options);
}

async function tmuxTargetExists(host: string | undefined, target: string): Promise<boolean> {
	const result = await runHostRaw(host, `tmux display-message -p -t ${shellQuote(target)} '#{pane_id}'`);
	return result.code === 0 && result.stdout.toString().trim().startsWith("%");
}

type TmuxPanePosition = {
	historySize: number;
	cursorY: number;
	absoluteLine: number;
};

type TmuxProcessWaitState = {
	pid: string;
	stat: string;
	pgrp: string;
	tpgid: string;
	wchan: string;
	command: string;
	fdsToPaneTty: string[];
};

type TmuxInteractiveWait = {
	process: TmuxProcessWaitState;
};

async function tmuxPanePosition(host: string | undefined, target: string): Promise<TmuxPanePosition> {
	const value = await tmuxCommand(host, `tmux display-message -p -t ${shellQuote(target)} '#{history_size} #{cursor_y}'`);
	const [historyText, cursorText] = value.trim().split(/\s+/, 2);
	const historySize = Number.parseInt(historyText ?? "0", 10);
	const cursorY = Number.parseInt(cursorText ?? "0", 10);
	const safeHistorySize = Number.isFinite(historySize) ? historySize : 0;
	const safeCursorY = Number.isFinite(cursorY) ? cursorY : 0;
	return {
		historySize: safeHistorySize,
		cursorY: safeCursorY,
		absoluteLine: safeHistorySize + safeCursorY,
	};
}

async function tmuxCapture(host: string | undefined, target: string, start?: TmuxPanePosition, joinWrapped = false): Promise<string> {
	const joinFlag = joinWrapped ? " -J" : "";
	if (!start) return tmuxCommand(host, `tmux capture-pane -p${joinFlag} -S -2000 -t ${shellQuote(target)}`);
	const current = await tmuxPanePosition(host, target);
	const startLine = Math.max(-current.historySize, start.absoluteLine - current.historySize - 1);
	return tmuxCommand(host, `tmux capture-pane -p${joinFlag} -S ${startLine} -t ${shellQuote(target)}`);
}

async function tmuxPanePid(host: string | undefined, target: string): Promise<string> {
	return tmuxCommand(host, `tmux display-message -p -t ${shellQuote(target)} '#{pane_pid}'`).then((value) => value.trim());
}

async function tmuxPaneTty(host: string | undefined, target: string): Promise<string> {
	return tmuxCommand(host, `tmux display-message -p -t ${shellQuote(target)} '#{pane_tty}'`).then((value) => value.trim());
}

async function tmuxForegroundProcessGroup(host: string | undefined, target: string): Promise<string> {
	const panePid = await tmuxPanePid(host, target);
	if (!/^\d+$/.test(panePid)) return "";
	const script = `python3 - ${shellQuote(panePid)} <<'PY'
import sys
pid = sys.argv[1]
try:
    with open(f'/proc/{pid}/stat') as f:
        rest = f.read().split(') ', 1)[1].split()
    shell_pgrp = rest[2]
    foreground_pgrp = rest[5]
    if foreground_pgrp.isdigit() and foreground_pgrp != '0' and foreground_pgrp != '-1' and foreground_pgrp != shell_pgrp:
        print(foreground_pgrp)
except Exception:
    pass
PY`;
	return runHostChecked(host, script).then((value) => value.trim()).catch(() => "");
}

async function tmuxProcessGroupExists(host: string | undefined, pgrp: string): Promise<boolean> {
	if (!/^\d+$/.test(pgrp)) return false;
	const script = `python3 - ${shellQuote(pgrp)} <<'PY'
import os, sys
pgrp = sys.argv[1]
for pid in filter(str.isdigit, os.listdir('/proc')):
    try:
        with open(f'/proc/{pid}/stat') as f:
            rest = f.read().split(') ', 1)[1].split()
        if rest[2] == pgrp:
            print(pid)
            break
    except Exception:
        pass
PY`;
	const output = await runHostChecked(host, script).catch(() => "");
	return output.trim() !== "";
}

async function tmuxInterruptForegroundProcessGroup(host: string | undefined, target: string): Promise<void> {
	const [foregroundPgrp, panePid] = await Promise.all([
		tmuxForegroundProcessGroup(host, target).catch(() => ""),
		tmuxPanePid(host, target).catch(() => ""),
	]);
	if (!/^\d+$/.test(foregroundPgrp)) return;
	const paneShellPgrp = await runHostChecked(
		host,
		`python3 - ${shellQuote(panePid)} <<'PY'
import sys
pid = sys.argv[1]
try:
    with open(f'/proc/{pid}/stat') as f:
        print(f.read().split(') ', 1)[1].split()[2])
except Exception:
    pass
PY`,
	)
		.then((value) => value.trim())
		.catch(() => "");
	await runHostRaw(host, `kill -INT -${foregroundPgrp}`).catch(() => undefined);
	await new Promise((resolve) => setTimeout(resolve, 150));
	if (foregroundPgrp !== paneShellPgrp && (await tmuxProcessGroupExists(host, foregroundPgrp))) {
		await runHostRaw(host, `kill -TERM -${foregroundPgrp}`).catch(() => undefined);
	}
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

async function tmuxSendText(host: string | undefined, target: string, text: string, enter: boolean): Promise<void> {
	if (text) await tmuxCommand(host, `tmux send-keys -t ${shellQuote(target)} -l ${shellQuote(text)}`);
	if (enter) await tmuxCommand(host, `tmux send-keys -t ${shellQuote(target)} Enter`);
}

async function tmuxSendLiteral(host: string | undefined, target: string, literal: string): Promise<void> {
	await tmuxSendText(host, target, literal, true);
}

async function tmuxPasteText(host: string | undefined, target: string, text: string, id: string): Promise<void> {
	const bufferName = `shellgate_${id.replace(/[^A-Za-z0-9_]/g, "_")}`;
	await runHostChecked(host, `tmux load-buffer -b ${shellQuote(bufferName)} -`, { input: text });
	await tmuxCommand(host, `tmux paste-buffer -d -b ${shellQuote(bufferName)} -t ${shellQuote(target)}`);
	await tmuxCommand(host, `tmux send-keys -t ${shellQuote(target)} Enter`);
}

async function tmuxClearVisibleScreen(host: string | undefined, target: string): Promise<void> {
	await tmuxCommand(host, `tmux send-keys -t ${shellQuote(target)} C-l`);
	await new Promise((resolve) => setTimeout(resolve, 80));
}

function shellgateControlCommand(command: string): string {
	return isShellgateDebugEnabled() ? command : `${command};${shellgateHideRowsCommand(1)}`;
}

function hasReturnedToShellgatePrompt(capture: string): boolean {
	const promptLine = SHELLGATE_PROMPT.trimEnd();
	const lines = capture.replace(/\r/g, "").split("\n");
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const line = lines[index]?.trimEnd() ?? "";
		if (line === "") continue;
		return line === promptLine;
	}
	return false;
}

async function hideShellgateRows(host: string | undefined, target: string, previousRows: number): Promise<void> {
	if (isShellgateDebugEnabled()) return;
	if (previousRows <= 0) return;
	await tmuxSendLiteral(host, target, shellgateHideRowsCommand(previousRows + 1)).catch(() => undefined);
}

async function tmuxInstallPromptHelpers(host: string | undefined, target: string): Promise<void> {
	await tmuxPasteText(host, target, buildShellgateHelperScript(shellQuote, { debug: isShellgateDebugEnabled() }), `setup_${Date.now()}`);
	await new Promise((resolve) => setTimeout(resolve, 200));
	if (!isShellgateDebugEnabled()) await tmuxClearVisibleScreen(host, target).catch(() => undefined);
}

async function ensureTmuxPromptHelpers(backend: TmuxBackend): Promise<void> {
	if (backend.promptReady) return;
	await tmuxInstallPromptHelpers(backend.host, backend.target);
	backend.promptReady = true;
}

async function prepareInteractiveShellForCommand(host: string | undefined, target: string): Promise<void> {
	// tmux is only the transport here. The thing being reset is the persistent
	// interactive shell's input state: half-entered readline text, heredocs,
	// command substitutions, and continuation prompts such as zsh's bquote>.
	await tmuxCommand(host, `tmux send-keys -t ${shellQuote(target)} C-c`).catch(() => undefined);
	await new Promise((resolve) => setTimeout(resolve, 100));
}

export async function tmuxCleanPromptHelpers(host: string | undefined, target: string): Promise<void> {
	const cleanupCommand = `${SHELLGATE_CLEAN_FUNCTION} 2>/dev/null;unset -f ${SHELLGATE_ON_FUNCTION} ${SHELLGATE_OFF_FUNCTION} ${SHELLGATE_STATUS_FUNCTION} ${SHELLGATE_HIDE_FUNCTION} ${SHELLGATE_CLEAN_FUNCTION} 2>/dev/null;unset __sg_debug __sg_p __sg_q __sg_P __sg_Q __sg_r __sg_R __sg_a __sg_s __sg_c __sg_b __sg_n 2>/dev/null`;
	const command = isShellgateDebugEnabled() ? cleanupCommand : `${shellgateHideRowsCommand(1)};${cleanupCommand}`;
	await tmuxSendLiteral(host, target, command);
	await new Promise((resolve) => setTimeout(resolve, 150));
}

async function tmuxProbeShellCwd(host: string | undefined, target: string): Promise<string | undefined> {
	const id = randomUUID().replace(/-/g, "");
	const captureStart = await tmuxPanePosition(host, target).catch(() => undefined);
	await tmuxSendLiteral(host, target, `${SHELLGATE_STATUS_FUNCTION} ${shellQuote(id)}`);
	const deadline = Date.now() + 3000;
	while (Date.now() < deadline) {
		const visualCapture = await tmuxCapture(host, target, captureStart).catch(() => "");
		const joinedCapture = await tmuxCapture(host, target, captureStart, true).catch(() => visualCapture);
		const parsed = extractPromptModeOutput(joinedCapture, id, visualCapture);
		if (parsed.complete) {
			await hideShellgateRows(host, target, parsed.statusRows).catch(() => undefined);
			return parsed.cwd;
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return undefined;
}

function isInputWaitWchan(wchan: string): boolean {
	const inputWaitNames = ["tty_read", "n_tty_read", "read_chan", "do_select", "do_poll", "poll_schedule_timeout", "ep_poll", "wait_woken"];
	return inputWaitNames.some((name) => wchan === name || wchan.startsWith(`${name}.`));
}

function isForegroundProcess(state: TmuxProcessWaitState): boolean {
	return state.pgrp !== "" && state.tpgid !== "" && state.tpgid !== "-1" && state.pgrp === state.tpgid;
}

function parseWaitState(line: string): TmuxProcessWaitState | undefined {
	const [pid, stat, pgrp, tpgid, wchan, command, fdsText = ""] = line.trim().split("\t");
	if (!pid || !stat || !pgrp || !tpgid || !wchan || !command) return undefined;
	const fdsToPaneTty = fdsText && fdsText !== "-" ? fdsText.split(",").filter(Boolean) : [];
	return { pid, stat, pgrp, tpgid, wchan, command, fdsToPaneTty };
}

async function tmuxProcessWaitStates(host: string | undefined, rootPid: string, paneTty: string): Promise<TmuxProcessWaitState[]> {
	if (!/^\d+$/.test(rootPid) || !paneTty) return [];
	const script = `python3 - ${shellQuote(rootPid)} ${shellQuote(paneTty)} <<'PY'
import os, sys
root = sys.argv[1]
pane_tty = sys.argv[2]
children = {}
for pid in filter(str.isdigit, os.listdir('/proc')):
    try:
        with open(f'/proc/{pid}/stat') as f:
            stat = f.read()
        ppid = stat[stat.rfind(')') + 2:].split()[1]
        children.setdefault(ppid, []).append(pid)
    except Exception:
        pass
stack = [root] + list(children.get(root, []))
seen = set()
while stack:
    pid = stack.pop()
    if pid in seen:
        continue
    seen.add(pid)
    stack.extend(children.get(pid, []))
    try:
        with open(f'/proc/{pid}/stat') as f:
            rest = f.read().split(') ', 1)[1].split()
        state = rest[0]
        pgrp = rest[2]
        tpgid = rest[5]
    except Exception:
        state = '?'
        pgrp = '?'
        tpgid = '?'
    try:
        with open(f'/proc/{pid}/wchan') as f:
            wchan = f.read().strip() or '-'
    except Exception:
        wchan = '?'
    try:
        with open(f'/proc/{pid}/comm') as f:
            comm = f.read().strip()
    except Exception:
        comm = '?'
    fds = []
    try:
        fd_dir = f'/proc/{pid}/fd'
        for fd in os.listdir(fd_dir):
            try:
                if os.readlink(os.path.join(fd_dir, fd)) == pane_tty:
                    fds.append(fd)
            except Exception:
                pass
    except Exception:
        pass
    fds.sort(key=lambda value: int(value) if value.isdigit() else value)
    print('\t'.join([pid, state, pgrp, tpgid, wchan, comm, ','.join(fds) or '-']))
PY`;
	const output = await runHostChecked(host, script).catch(() => "");
	return output.split("\n").map(parseWaitState).filter((state): state is TmuxProcessWaitState => Boolean(state));
}

async function detectTmuxInteractiveWait(host: string | undefined, target: string): Promise<TmuxInteractiveWait | undefined> {
	const [panePid, paneTty] = await Promise.all([
		tmuxPanePid(host, target).catch(() => ""),
		tmuxPaneTty(host, target).catch(() => ""),
	]);
	const states = await tmuxProcessWaitStates(host, panePid, paneTty).catch(() => []);
	const process = states.find(
		(state) =>
			state.pid !== panePid &&
			isForegroundProcess(state) &&
			state.fdsToPaneTty.length > 0 &&
			isInputWaitWchan(state.wchan),
	);
	return process ? { process } : undefined;
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

export async function runTmuxBackend(
	backend: TmuxBackend,
	command: string,
	optionsCwd: string,
	options: CommandOptions = {},
): Promise<RawResult> {
	return enqueueTmux(async () => {
		if (backend.interactive) {
			throw new Error(
				`target shell is waiting for input in ${backend.interactive.process.command} (pid ${backend.interactive.process.pid}, wchan=${backend.interactive.process.wchan}); use shellgate_send to send input or keys`,
			);
		}
		await prepareInteractiveShellForCommand(backend.host, backend.target);
		backend.promptActive = false;
		await ensureTmuxPromptHelpers(backend);
		const id = randomUUID().replace(/-/g, "");
		const targetCwd = mapPath(optionsCwd, process.cwd(), backend);
		if (!backend.promptActive) {
			await tmuxSendLiteral(backend.host, backend.target, shellgateControlCommand(SHELLGATE_ON_FUNCTION));
			backend.promptActive = true;
			await new Promise((resolve) => setTimeout(resolve, 120));
		}
		const captureStart = await tmuxPanePosition(backend.host, backend.target).catch(() => undefined);
		const commandBlock = [`cd ${shellQuote(targetCwd)}`, command].join("\n");
		await tmuxPasteText(backend.host, backend.target, commandBlock, id);

		const cleanup = async () => {
			backend.promptActive = false;
			await tmuxInterruptForegroundProcessGroup(backend.host, backend.target).catch(() => undefined);
			await new Promise((resolve) => setTimeout(resolve, 120));
			await tmuxCommand(backend.host, `tmux send-keys -t ${shellQuote(backend.target)} C-c`).catch(() => undefined);
			await new Promise((resolve) => setTimeout(resolve, 120));
			await tmuxSendLiteral(backend.host, backend.target, shellgateControlCommand(SHELLGATE_OFF_FUNCTION)).catch(() => undefined);
		};

		return new Promise<RawResult>((resolve, reject) => {
			let lastOutput = "";
			let settled = false;
			let statusRequested = false;
			let interactiveCheckInFlight = false;

			const settle = (fn: () => void) => {
				if (settled) return;
				settled = true;
				clearInterval(interval);
				if (timer) clearTimeout(timer);
				options.signal?.removeEventListener("abort", onAbort);
				fn();
			};

			const finishFromCapture = async (visualCapture: string) => {
				const joinedCapture = await tmuxCapture(backend.host, backend.target, captureStart, true).catch(() => visualCapture);
				const parsed = extractPromptModeOutput(joinedCapture, id, visualCapture);
				const currentOutput = parsed.complete ? parsed.output : parsed.partial;
				if (currentOutput.length > lastOutput.length) {
					options.onStdout?.(Buffer.from(currentOutput.slice(lastOutput.length)));
					lastOutput = currentOutput;
				}
				if (!parsed.complete) {
					if (!statusRequested && hasReturnedToShellgatePrompt(visualCapture)) {
						statusRequested = true;
						await tmuxSendLiteral(backend.host, backend.target, `${SHELLGATE_STATUS_FUNCTION} ${shellQuote(id)}`);
						return;
					}
					if (!statusRequested && !interactiveCheckInFlight) {
						interactiveCheckInFlight = true;
						detectTmuxInteractiveWait(backend.host, backend.target)
							.then((wait) => {
								interactiveCheckInFlight = false;
								if (!wait) return;
								backend.interactive = { statusId: id, captureStart, lastOutput, process: wait.process };
								const error = new Error(
									`target shell is waiting for input: pid ${wait.process.pid}, ${wait.process.command}, wchan=${wait.process.wchan}, pgrp=${wait.process.pgrp}, tpgid=${wait.process.tpgid}, tty_fds=${wait.process.fdsToPaneTty.join(",")}; shell left in interactive state, use shellgate_send to send input or keys`,
								);
								settle(() => reject(error));
							})
							.catch(() => {
								interactiveCheckInFlight = false;
							});
					}
					return;
				}
				await hideShellgateRows(backend.host, backend.target, parsed.statusRows);
				backend.promptActive = false;
				backend.interactive = undefined;
				if (parsed.cwd) backend.cwd = parsed.cwd;
				settle(() =>
					resolve({
						code: parsed.status,
						stdout: Buffer.from(parsed.output),
						stderr: Buffer.alloc(0),
						killed: false,
					}),
				);
			};

			const poll = () => {
				tmuxCapture(backend.host, backend.target, captureStart)
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

export async function activateTmux(host: string | undefined, target: string, path: string | undefined, create: boolean): Promise<TmuxBackend> {
	let cwd = path;
	const displayTarget = target;
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
	const existingWait = await detectTmuxInteractiveWait(host, stableTarget).catch(() => undefined);
	if (existingWait) {
		const captureStart = await tmuxPanePosition(host, stableTarget).catch(() => undefined);
		const lastOutput = captureStart ? await tmuxCapture(host, stableTarget, captureStart, true).catch(() => "") : "";
		return {
			kind: "tmux",
			host,
			target: stableTarget,
			displayTarget,
			cwd: cwd || (await tmuxPaneCwd(host, stableTarget)),
			promptReady: false,
			promptActive: false,
			interactive: {
				statusId: randomUUID().replace(/-/g, ""),
				captureStart,
				lastOutput,
				process: existingWait.process,
			},
		};
	}
	await prepareInteractiveShellForCommand(host, stableTarget);
	if (cwd) {
		await tmuxSendLiteral(host, stableTarget, `cd ${shellQuote(cwd)}`);
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	await tmuxCommand(host, `tmux set-option -t ${shellQuote(target)} history-limit 100000`).catch(() => undefined);
	await tmuxInstallPromptHelpers(host, stableTarget);
	const shellCwd = await tmuxProbeShellCwd(host, stableTarget).catch(() => undefined);
	const backend: TmuxBackend = {
		kind: "tmux",
		host,
		target: stableTarget,
		displayTarget,
		cwd: shellCwd || cwd || (await tmuxPaneCwd(host, stableTarget)),
		promptReady: true,
		promptActive: false,
	};
	return backend;
}


export type TmuxSendResult = {
	output: string;
	state: "waiting" | "running" | "completed";
	exitCode?: number;
	cwd?: string;
};

async function waitForInteractiveAfterSend(backend: TmuxBackend, captureStart: TmuxPanePosition | undefined, previousOutput: string): Promise<TmuxSendResult> {
	const deadline = Date.now() + 2000;
	let latestOutput = previousOutput;
	while (Date.now() < deadline) {
		const visualCapture = await tmuxCapture(backend.host, backend.target, captureStart).catch(() => "");
		const joinedCapture = await tmuxCapture(backend.host, backend.target, captureStart, true).catch(() => visualCapture);
		const parsed = extractPromptModeOutput(joinedCapture, backend.interactive?.statusId ?? "", visualCapture);
		const currentOutput = parsed.complete ? parsed.output : parsed.partial;
		latestOutput = currentOutput;
		if (parsed.complete) {
			await hideShellgateRows(backend.host, backend.target, parsed.statusRows).catch(() => undefined);
			backend.promptActive = false;
			backend.interactive = undefined;
			if (parsed.cwd) backend.cwd = parsed.cwd;
			return {
				output: currentOutput.slice(previousOutput.length),
				state: "completed",
				exitCode: parsed.status,
				cwd: parsed.cwd,
			};
		}
		const wait = await detectTmuxInteractiveWait(backend.host, backend.target).catch(() => undefined);
		if (wait) {
			if (backend.interactive) {
				backend.interactive.lastOutput = currentOutput;
				backend.interactive.process = wait.process;
			}
			return { output: currentOutput.slice(previousOutput.length), state: "waiting" };
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	if (backend.interactive) backend.interactive.lastOutput = latestOutput;
	return { output: latestOutput.slice(previousOutput.length), state: "running" };
}

export async function sendTmuxInteractiveInput(
	backend: TmuxBackend,
	input: { text?: string; key?: string; enter?: boolean },
): Promise<TmuxSendResult> {
	return enqueueTmux(async () => {
		if (!backend.interactive) {
			const wait = await detectTmuxInteractiveWait(backend.host, backend.target).catch(() => undefined);
			if (!wait) throw new Error("target shell is not currently waiting for interactive input");
			const statusId = randomUUID().replace(/-/g, "");
			const captureStart = await tmuxPanePosition(backend.host, backend.target).catch(() => undefined);
			const previousOutput = captureStart ? (await tmuxCapture(backend.host, backend.target, captureStart, true).catch(() => "")) : "";
			backend.interactive = { statusId, captureStart, lastOutput: previousOutput, process: wait.process };
		}
		const captureStart = await tmuxPanePosition(backend.host, backend.target).catch(() => backend.interactive?.captureStart);
		const previousOutput = backend.interactive.lastOutput;
		backend.interactive.captureStart = captureStart;
		if (input.key) {
			await tmuxCommand(backend.host, `tmux send-keys -t ${shellQuote(backend.target)} ${shellQuote(input.key)}`);
		} else {
			await tmuxSendText(backend.host, backend.target, input.text ?? "", input.enter ?? true);
		}
		await new Promise((resolve) => setTimeout(resolve, 120));
		const wait = await detectTmuxInteractiveWait(backend.host, backend.target).catch(() => undefined);
		if (wait) {
			backend.interactive.process = wait.process;
			return waitForInteractiveAfterSend(backend, captureStart, previousOutput);
		}
		if (hasReturnedToShellgatePrompt(await tmuxCapture(backend.host, backend.target, captureStart).catch(() => ""))) {
			await tmuxSendLiteral(backend.host, backend.target, `${SHELLGATE_STATUS_FUNCTION} ${shellQuote(backend.interactive.statusId)}`);
		}
		return waitForInteractiveAfterSend(backend, captureStart, previousOutput);
	});
}
