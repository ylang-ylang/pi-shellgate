export const SHELLGATE_PROMPT = "shellgate$ ";
export const SHELLGATE_CONT_PROMPT = "shellgate> ";
export const SHELLGATE_SETUP_NOTICE = "--- ShellGate setup ready: helpers installed; /shellgate clean removes them ---";

export const SHELLGATE_ON_FUNCTION = "__sg_on";
export const SHELLGATE_OFF_FUNCTION = "__sg_off";
export const SHELLGATE_STATUS_FUNCTION = "__sg_status";
export const SHELLGATE_HIDE_FUNCTION = "__sg_h";
export const SHELLGATE_CLEAN_FUNCTION = "__sg_clean";

export type PromptModeOutput =
	| { complete: false; partial: string }
	| { complete: true; output: string; status: number; cwd?: string; statusRows: number };

export function isShellgateDebugEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const value = env.SHELLGATE_DEBUG;
	if (value === undefined) return false;
	const normalized = value.trim().toLowerCase();
	return normalized !== "" && normalized !== "0" && normalized !== "false" && normalized !== "no";
}

export function shellgateHideRowsCommand(rows: number): string {
	const safeRows = Math.max(0, Math.ceil(rows));
	return safeRows > 0 ? `${SHELLGATE_HIDE_FUNCTION} ${safeRows}` : ":";
}

export function buildShellgateHelperScript(shellQuote: (value: string) => string, options: { debug?: boolean } = {}): string {
	const debugValue = options.debug ? "1" : "0";
	return [
		`__sg_debug=${shellQuote(debugValue)}`,
		`${SHELLGATE_ON_FUNCTION}(){ [ -z "\${__sg_a+x}" ]&&{ __sg_p=\${PS1-};__sg_q=\${PS2-};__sg_P=\${PROMPT-};__sg_Q=\${PROMPT2-};__sg_r=\${RPROMPT-};__sg_R=\${RPS1-};};__sg_a=1;PS1=${shellQuote(SHELLGATE_PROMPT)};PROMPT=${shellQuote(SHELLGATE_PROMPT)};PS2=${shellQuote(SHELLGATE_CONT_PROMPT)};PROMPT2=${shellQuote(SHELLGATE_CONT_PROMPT)};RPROMPT=;RPS1=;}`,
		`${SHELLGATE_OFF_FUNCTION}(){ [ -n "\${__sg_a+x}" ]&&{ PS1=$__sg_p;PS2=$__sg_q;PROMPT=$__sg_P;PROMPT2=$__sg_Q;RPROMPT=$__sg_r;RPS1=$__sg_R;unset __sg_p __sg_q __sg_P __sg_Q __sg_r __sg_R __sg_a;};}`,
		`${SHELLGATE_HIDE_FUNCTION}(){ [ "\${__sg_debug:-0}" != 0 ]&&return 0;__sg_n=\${1:-0};while [ "$__sg_n" -gt 0 ];do printf '\\033[1A\\033[2K';__sg_n=$((__sg_n-1));done 2>/dev/null;unset __sg_n;}`,
		`${SHELLGATE_STATUS_FUNCTION}(){ __sg_s=$?;__sg_c=$(pwd -P 2>/dev/null||pwd);__sg_b=$(printf %s "$__sg_c"|base64|tr -d '\\n');printf '\\n__SG_STATUS_%s__:%s:%s\\n' "$1" "$__sg_s" "$__sg_b";${SHELLGATE_OFF_FUNCTION} 2>/dev/null;}`,
		`${SHELLGATE_CLEAN_FUNCTION}(){ ${SHELLGATE_OFF_FUNCTION} 2>/dev/null;unset -f ${SHELLGATE_ON_FUNCTION} ${SHELLGATE_OFF_FUNCTION} ${SHELLGATE_STATUS_FUNCTION} ${SHELLGATE_HIDE_FUNCTION} ${SHELLGATE_CLEAN_FUNCTION} 2>/dev/null;unset __sg_debug __sg_p __sg_q __sg_P __sg_Q __sg_r __sg_R __sg_a __sg_s __sg_c __sg_b __sg_n 2>/dev/null;}`,
		`echo ${shellQuote(SHELLGATE_SETUP_NOTICE)}`,
	].join("\n");
}

function countStatusRows(visualCapture: string, id: string): number {
	const lines = visualCapture.replace(/\r/g, "").split("\n");
	const statusPrefix = `__SG_STATUS_${id}__:`;
	const statusLineIndex = lines.findLastIndex((line) => line.includes(statusPrefix));
	if (statusLineIndex === -1) return 0;

	let markerEndIndex = statusLineIndex + 1;
	for (let index = statusLineIndex + 1; index < lines.length; index += 1) {
		const trimmedLine = lines[index]?.trim() ?? "";
		if (!/^[A-Za-z0-9+/=:_-]+$/.test(trimmedLine)) break;
		markerEndIndex = index + 1;
	}

	let commandLineIndex = -1;
	for (let index = statusLineIndex - 1; index >= 0; index -= 1) {
		const line = lines[index] ?? "";
		if (line.includes(`${SHELLGATE_STATUS_FUNCTION} `)) {
			commandLineIndex = index;
			break;
		}
	}

	if (commandLineIndex === -1) return Math.max(1, markerEndIndex - statusLineIndex);
	const commandLine = lines[commandLineIndex] ?? "";
	const shellgatePromptNeedle = `${SHELLGATE_PROMPT}${SHELLGATE_STATUS_FUNCTION} `;
	const promptIndex = commandLine.indexOf(shellgatePromptNeedle);
	const hasUserOutputPrefix = promptIndex > 0 && commandLine.slice(0, promptIndex).trimEnd() !== "";
	const startIndex = hasUserOutputPrefix ? statusLineIndex : commandLineIndex;
	return Math.max(1, markerEndIndex - startIndex);
}

function isHelperSetupLine(line: string): boolean {
	return (
		line.includes(SHELLGATE_SETUP_NOTICE) ||
		line.includes(`${SHELLGATE_ON_FUNCTION}(){`) ||
		line.includes(`${SHELLGATE_OFF_FUNCTION}(){`) ||
		line.includes(`${SHELLGATE_HIDE_FUNCTION}(){`) ||
		line.includes(`${SHELLGATE_STATUS_FUNCTION}(){`) ||
		line.includes(`${SHELLGATE_CLEAN_FUNCTION}(){`) ||
		line.includes("__SG_STATUS_%s__")
	);
}

export function stripPromptLines(body: string): string {
	const lines = body.split("\n");
	const firstPromptIndex = lines.findIndex((line) => line.startsWith(SHELLGATE_PROMPT) || line.startsWith(SHELLGATE_CONT_PROMPT));
	const scopedLines = firstPromptIndex === -1 ? lines : lines.slice(firstPromptIndex);
	const outputLines: string[] = [];
	let skippingSetupContinuation = false;
	for (const line of scopedLines) {
		if (line.startsWith(SHELLGATE_PROMPT) || line.startsWith(SHELLGATE_CONT_PROMPT)) {
			skippingSetupContinuation = isHelperSetupLine(line);
			continue;
		}
		if (isHelperSetupLine(line)) {
			skippingSetupContinuation = true;
			continue;
		}
		const statusPromptIndex = line.indexOf(`${SHELLGATE_PROMPT}${SHELLGATE_STATUS_FUNCTION} `);
		if (statusPromptIndex !== -1) {
			outputLines.push(line.slice(0, statusPromptIndex));
			continue;
		}
		if (line.trimStart().startsWith(`${SHELLGATE_STATUS_FUNCTION} `)) continue;
		if (skippingSetupContinuation) {
			if (line.trim() === "" || /^[A-Za-z_][A-Za-z0-9_]*[=>]? /.test(line) || line.includes("function ")) continue;
			skippingSetupContinuation = false;
		}
		outputLines.push(line);
	}
	return outputLines.join("\n").replace(/^[\s\n]+/, "").replace(/[\s\n]+$/, "");
}

export function extractPromptModeOutput(capture: string, id: string, visualCapture = capture): PromptModeOutput {
	const normalized = capture.replace(/\r/g, "");
	const statusPrefix = `__SG_STATUS_${id}__:`;
	const statusIndex = normalized.lastIndexOf(statusPrefix);
	const body = statusIndex === -1 ? normalized : normalized.slice(0, statusIndex);
	const output = stripPromptLines(body);
	if (statusIndex === -1) return { complete: false, partial: output };
	const statusLine = normalized.slice(statusIndex + statusPrefix.length).split("\n", 1)[0]?.trim() ?? "1";
	const [statusText, cwdB64] = statusLine.split(":", 2);
	const status = Number.parseInt(statusText ?? "1", 10);
	const cwd = cwdB64 ? Buffer.from(cwdB64, "base64").toString() : undefined;
	return {
		complete: true,
		output,
		status: Number.isFinite(status) ? status : 1,
		cwd,
		statusRows: countStatusRows(visualCapture, id),
	};
}
