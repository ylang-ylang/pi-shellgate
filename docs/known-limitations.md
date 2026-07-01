# Known Limitations

ShellGate routes normal pi tools through local, SSH, and broker-managed tmux backends. The tmux backend is no longer attach mode: a broker owns a child pty and a real child shell, and all agent commands go through the broker socket.

## Broker-Managed Tmux

### The child shell is real, but not the original parent shell

In tmux broker mode, the user and agent cowork in the broker-managed child shell. If the broker is started from a normal pane shell with `--adopt`, the broker inherits exported environment variables and `$SHELL` from that shell. The child shell then starts as that shell, for example `/usr/bin/zsh`.

This still does not share private shell state from the original parent shell:

- aliases
- shell functions
- unexported variables
- job table
- shell options
- readline state

Those are process-private state in the original shell. The original shell is only the launcher for the broker.

### Agent command boundaries are internal broker protocol

The old attach protocol (`__sg_on`, `__sg_status`, prompt helpers, and `shellgate_send`) has been removed from the main ShellGate path. Broker mode still needs internal boundaries to return structured tool results. Those boundaries use `__SGB_*` markers inside the managed child shell during an agent transaction.

When no agent transaction is active, broker mode relays user input and child shell output directly. The user should see the real child shell prompt and behavior.

### stdout and stderr are merged

The broker talks to the child shell through a pty. By the time output reaches ShellGate, stdout and stderr are merged into the terminal transcript.

Observed impact:

- stderr appears in the tool output stream together with stdout.
- Exit codes are still captured separately.
- This differs from local process execution, where stdout and stderr can be separated.

### Interactive programs run in the child shell

Programs such as `pdb`, `python input()`, editors, and REPLs run in the same child pty that the user sees. The broker detects common terminal-input waits with fd/pgrp/wchan checks and returns immediately without killing the program.

The user can interact directly in the pane. The agent can also send explicit input with `shellgate_input`, which writes through the broker socket to the child pty and returns the output delta captured after that input. This is not tmux attach and does not use `tmux send-keys`.

When no interactive foreground process is detected, `shellgate_input` returns `sent:false` and does not write to the idle shell. Use `force:true` only when intentionally sending raw input to the managed shell.

`bash/read/write/edit` should not be used concurrently against the same managed shell while the user is actively driving an interactive full-screen or line-oriented program.

### Command history suppression is best-effort

Broker `--history off` is shell-agnostic. It prefixes generated ShellGate transaction lines with a leading space and does not set zsh, bash, or fish-specific options. Shells that are not configured to ignore leading-space history entries may still persist those internal lines. Stronger guarantees require shell-specific adapters.

### `/shellgate off` stops the active broker

`/shellgate off` clears ShellGate routing and asks the active broker to shut down. Broker shutdown sends `SIGHUP` to the managed child shell and removes the broker socket. If a foreground program is running inside that child shell, it is part of the managed shell session and may also receive hangup behavior from the pty/session.

### `exit` exits the child shell

A direct `exit` in broker mode exits the managed child shell. Depending on the broker state, this can end the broker session for that pane. To test an exit code without ending the shell, use a subshell:

```sh
( exit 7 )
bash -lc 'exit 7'
```
