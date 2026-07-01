# ShellGate Broker Test Baseline

This baseline documents the expected behavior after removing tmux attach mode. All tmux command forms must use the broker-managed child shell backend.

## Load Check

Run from the repo:

```sh
PI_OFFLINE=1 pi --no-context-files --no-skills --no-prompt-templates --no-themes -e extensions/shellgate.ts --list-models shellgate-load-test
python3 -m py_compile extensions/shellgate-broker.py
```

Expected:

```text
load_exit=0
No models matching "shellgate-load-test"
```

## New Managed Session

Connect:

```text
/shellgate tmux shellgate-managed /home/ylang/ylangs_ws/pi-shellgate
```

Equivalent:

```text
/shellgate tmux-managed shellgate-managed /home/ylang/ylangs_ws/pi-shellgate
```

Expected:

- A tmux session/pane starts with foreground `python3 shellgate-broker.py`.
- The broker starts a real child shell from `$SHELL`, usually zsh on the local host.
- The pane displays the child shell naturally when no agent transaction is active.
- Normal `bash/read/write/edit` run through the broker socket.
- No `__sg_on`, `__sg_status`, `__sg_clean`, or attach prompt helpers appear.

## Existing Pane Adopt

Create or choose a visible pane such as `%88`, then connect:

```text
/shellgate tmux %88 /home/ylang/ylangs_ws/pi-shellgate --adopt
```

Equivalent:

```text
/shellgate tmux-managed %88 /home/ylang/ylangs_ws/pi-shellgate --adopt
```

Expected:

- The existing pane shell runs a short launcher such as `/tmp/shellgate-launch-_88.sh`.
- The launcher execs `shellgate-broker.py` as the foreground program.
- The broker inherits exported env and `$SHELL` from the original pane shell.
- The original pane shell is no longer the command execution backend.
- User and agent cowork in the broker-managed child shell.

## Basic Commands

Run with normal `bash` tool:

```sh
pwd && echo broker-basic-ok && printf 'shell=%s\n' "$SHELL"
```

Expected output includes:

```text
/home/ylang/ylangs_ws/pi-shellgate
broker-basic-ok
shell=/usr/bin/zsh
```

The exact shell path should match the environment used to launch the broker.

## Prompt Boundary

In an adopted pane, compare the original prompt behavior with the broker-managed child shell prompt.

Expected:

- The broker child shell is a real shell and should load its normal startup files.
- Exported environment variables and `$SHELL` can be inherited through the adopt launcher.
- Non-exported shell variables and in-memory prompt state, including typical `PS1`, `PS2`, `PROMPT`, and `RPROMPT` values, are not guaranteed to transfer from the original parent shell.
- ShellGate's own visible transaction label is `[shellgate] command`, not `$ command` and not a copy of the user's prompt.

## Persistent cwd

Run:

```sh
cd /tmp && pwd
pwd
```

Expected:

```text
/tmp
/tmp
```

The second command should use the child shell's current cwd when the tool call does not specify an explicit cwd.

## File Operations

Use normal `write`, `read`, and `edit` tools against `/tmp/shellgate-baseline-file.txt`.

Expected final file content:

```text
alpha
beta
```

Expected pane behavior:

```text
[shellgate] write /tmp/shellgate-baseline-file.txt (... bytes)
[shellgate] read /tmp/shellgate-baseline-file.txt
[shellgate] access rw /tmp/shellgate-baseline-file.txt
```

ShellGate transaction labels must not pretend to be the user's prompt. Base64/heredoc transport should not be visible in the pane.

## Exit Code Without Ending Shell

Run:

```sh
( exit 7 )
```

Expected tool result reports exit code 7, and the broker/child shell remains alive.

Do not use direct `exit` as a routine test; direct `exit` exits the managed child shell.

## Interactive Programs

Run:

```sh
python3 -m pdb /tmp/shellgate-broker-pdb-demo.py
```

Expected:

- The broker detects the foreground process waiting for terminal input by checking child-shell descendants, foreground pgrp, fd links to the child pty, and input-like `wchan`.
- The tool call returns immediately with an interactive-wait error instead of timing out.
- The debugger remains alive in the managed pane.

Continue debugging through ShellGate broker input, not tmux:

```json
{ "text": "where", "enter": true }
{ "text": "n", "enter": true }
{ "text": "p x", "enter": true }
```

Expected:

- `shellgate_input` sends input through the broker socket to the child pty.
- The tool result includes the output delta returned by the broker after each input, not just an acknowledgement.
- If the child shell is idle, `shellgate_input` returns `sent:false` and does not write the text unless `force:true` is supplied.
- No `tmux send-keys` is needed for agent-driven debugging.
- Do not run normal `bash/read/write/edit` transactions concurrently while the child shell is intentionally inside an interactive foreground program.

## Foreground Detection Regression

Run a non-interactive command that includes a short-lived pipeline stage with stdout/stderr attached to the pty:

```sh
ps -eo pid,ppid,stat,args | rg 'shellgate-managed|shellgate-broker.py|PID'
```

Expected:

- The command completes normally and returns its output.
- The broker must not report an interactive-wait error for `rg` or similar pipeline stages just because fd 1 or fd 2 points at the pty.
- Interactive-wait detection should require stdin fd 0 to point at the managed pty slave.

## Pane Output Backpressure

Run a command that writes enough terminal output to exercise pane stdout backpressure, for example:

```sh
python3 - <<'PY'
for i in range(20000):
    print('shellgate-output-backpressure', i)
PY
```

Expected:

- The broker remains alive.
- The command completes or times out through normal ShellGate command handling.
- The broker must not crash with `BlockingIOError` while writing child pty output back to the visible pane.

## Disconnect And History

After connecting to a managed tmux backend, run `/shellgate off` or `shellgate_connect({"mode":"off"})`.

Expected:

- ShellGate returns to normal local shell routing.
- The active broker receives a shutdown request, exits, and removes its socket.
- The managed child shell receives broker shutdown/hangup rather than being left as an orphaned backend.

Default broker launches include `--history off`.

Expected:

- ShellGate does not configure zsh/bash/fish-specific history options.
- Generated agent transaction lines are prefixed with a leading space as a shell-agnostic best-effort history suppression strategy.

## Removed Attach Checks

These must be true after `/reload`:

- `shellgate_connect({mode: "tmux", ...})` creates or reuses broker-managed mode, not attach.
- `shellgate_connect({mode: "ssh-tmux", ...})` creates or reuses broker-managed mode, not attach.
- `shellgate_send` is no longer registered; broker-native interactive input is `shellgate_input`.
- `extensions/tmux-backend.ts` and `extensions/tmux-helpers.ts` are not part of the package.
- Old serialized `kind: "tmux"` state is ignored on session restore.
