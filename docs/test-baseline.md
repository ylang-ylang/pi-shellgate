# ShellGate Test Baseline

This baseline documents the expected behavior for the ShellGate extension after connecting to a tmux pane. It is intended as a manual regression checklist for prompt-mode tmux routing.

## Test Setup

Use a dedicated visible tmux pane so screen output can be inspected without affecting other work:

```sh
tmux new-window -P -F '#{pane_id}' -t vscode-pi-shellgate -n shellgate-baseline -c /home/ylang/ylangs_ws/pi-shellgate zsh
```

Connect ShellGate to that pane:

```text
/shellgate tmux %73 /home/ylang/ylangs_ws/pi-shellgate
```

Before testing, reset debug/cleanup state in the pane:

```sh
stty echo 2>/dev/null; unset SHELLGATE_DEBUG; __sg_clean 2>/dev/null; clear
```

ShellGate also sends a `C-c` preflight before each command injection into a persistent interactive shell. This is intentional: it cancels half-entered readline text, heredocs, command substitutions, or continuation prompts such as `bquote>` before the agent pastes a command. This is a shell-state problem, not a tmux semantic. tmux is only the current transport used to drive a visible persistent shell. The preflight should not be used to interrupt a command the user explicitly wants to keep running in the target shell.

Implementation boundary:

- `cd`, `source`, `export`, aliases, prompt state, partial input, and `exit/exec` behavior are shell semantics.
- `send-keys`, `paste-buffer`, `capture-pane`, pane id resolution, and current-screen cleanup are tmux transport mechanics.
- Local and plain SSH backends currently run commands in fresh child shells, so they do not retain readline/continuation state between tool calls. If ShellGate later adds a persistent non-tmux shell transport, the same interactive-shell preflight rules apply there too.

Run the extension load check from the repo:

```sh
PI_OFFLINE=1 pi --no-context-files --no-skills --no-prompt-templates --no-themes -e extensions/shellgate.ts --list-models shellgate-load-test
```

Expected:

```text
load_exit=0
No models matching "shellgate-load-test"
```

## Expected Tmux Visual Mode

Default mode should show real shell commands, not a fake command line and not a hidden wrapper. For a normal command, the visible pane should look like:

```text
shellgate$ cd '/home/ylang/ylangs_ws/pi-shellgate'
shellgate$ pwd && echo visible-ok
/home/ylang/ylangs_ws/pi-shellgate
visible-ok
```

The current screen should not contain ShellGate internal protocol lines:

```text
__sg_on
__sg_h
__sg_status
__SG_STATUS
--- ShellGate setup ready
```

`SHELLGATE_DEBUG=1` in the pi extension process is the exception: debug mode intentionally leaves internal protocol visible. A `SHELLGATE_DEBUG` variable already present inside the target shell must not control ShellGate hiding; the helper uses ShellGate's internal `__sg_debug` value injected by the extension.

## Baseline Cases

### Basic command output

```sh
pwd && echo baseline-basic-ok
```

Expected tool output includes:

```text
/home/ylang/ylangs_ws/pi-shellgate
baseline-basic-ok
```

### Persistent cwd

```sh
cd /tmp && pwd
pwd
```

Expected:

```text
/tmp
/tmp
```

### Exit code without killing pane

```sh
( exit 7 )
```

Expected tool result:

```text
Command exited with code 7
```

The tmux pane must remain alive.

### File operations

Use normal `write`, `read`, and `edit` tools against `/tmp/shellgate-baseline-file.txt`.

Expected final file content:

```text
alpha
beta
```

### Non-interactive wait should not misfire

```sh
sleep 1 && echo baseline-sleep-ok
```

Expected:

```text
baseline-sleep-ok
```

No interactive-wait error should be reported.

### Python input detection

```sh
python3 -c "value = input('Password: '); print('got', len(value))"
```

Expected ShellGate error:

```text
tmux pane foreground process appears blocked waiting for input: pid ..., python3, wchan=wait_woken, pgrp=..., tpgid=..., tty_fds=0,1,2
```

After cleanup, the pane should have no lingering `python3` child process.

### pdb detection

Create `/tmp/shellgate-pdb-test.py`:

```py
x = 1
print('before')
breakpoint()
print('after', x)
```

Run:

```sh
python3 -m pdb /tmp/shellgate-pdb-test.py
```

Expected ShellGate error:

```text
tmux pane foreground process appears blocked waiting for input: pid ..., python3, wchan=do_select, pgrp=..., tpgid=..., tty_fds=0,1,2
```

After cleanup, the pane should have no lingering `python3 -m pdb` child process.

## Known Boundaries

ShellGate's input-wait detection prioritizes precision over recall. It only reports high-confidence waits for foreground descendant processes whose file descriptors point at the pane tty and whose `wchan` is input-like.

Known limitations:

- The pane shell process itself is excluded to avoid false positives from idle `zsh`/`bash` prompts such as `do_poll` on the pane tty.
- Shell builtins such as `read secret` can fall back to the normal command timeout.
- `sudo` may report `wchan=0` or `WCHAN -`, with unreadable file descriptors, and is treated as unknown rather than definitely waiting for a password.
- Direct `exit` or `exec` in tmux backend can close or replace the pane shell. Use `( exit 7 )` or `bash -lc 'exit 7'` to test exit codes.

## Interactive Send Baseline

When ShellGate detects a foreground descendant process waiting for terminal input, it should return immediately and leave the shell in that interactive state. It must not automatically send `C-c`, `SIGINT`, or `SIGTERM` for this case.

Example with `pdb`:

```sh
python3 -m pdb /tmp/shellgate-pdb-test.py
```

Expected first response:

```text
target shell is waiting for input: pid ..., python3, wchan=do_select, ...; shell left in interactive state, use shellgate_send to send input or keys
```

Then use `shellgate_send`:

```json
{ "text": "where", "enter": true }
{ "text": "n", "enter": true }
{ "text": "c", "enter": true }
```

Expected behavior:

- The first command reports the interactive wait and leaves `pdb` running.
- `shellgate_send` sends text/keys to the interactive program, not to the shell prompt.
- Ordinary `bash/read/write/edit` calls fail while the backend is in interactive state, telling the agent to use `shellgate_send`.
- When the program exits back to `shellgate$`, ShellGate collects the normal status/cwd marker and clears the interactive state.
