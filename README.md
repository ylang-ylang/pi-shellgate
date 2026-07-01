# pi-shellgate

ShellGate is a [pi](https://pi.dev/) extension that routes the agent's normal `bash`, `read`, `write`, and `edit` tools through a selected shell backend.

Supported backends:

- Local directory
- SSH host
- Local tmux broker-managed child shell
- SSH tmux broker-managed child shell

ShellGate no longer has a tmux attach backend. All tmux modes use a broker process that owns a child pty and child shell.

## Install

```bash
pi install git:github.com/ylang-ylang/pi-shellgate
```

Or install from HTTPS:

```bash
pi install https://github.com/ylang-ylang/pi-shellgate
```

Restart pi or run `/reload` after installing.

## Usage

User commands:

```text
/shellgate status
/shellgate off
/shellgate ssh host[:/path]
/shellgate tmux session-or-pane [/path] [--adopt]
/shellgate ssh-tmux host session-or-pane [/path] [--adopt]
/shellgate tmux-managed session-or-pane [/path] [--adopt]
/shellgate ssh-tmux-managed host session-or-pane [/path] [--adopt]
```

Alias:

```text
/sg ssh host:/path
```

Natural language should also work because the extension registers `shellgate_connect` and prompt guidance:

```text
Please ssh to 192.168.201.15:/home/ylang/project and do the rest of the work there.
```

After connection, the agent should use ordinary tools, not wrap every command in `ssh` or `tmux`.

## Tmux Broker Mode

Managed tmux mode starts a ShellGate broker in a tmux pane. The broker creates a child pty and starts a real child shell, normally from `$SHELL` such as `/usr/bin/zsh`:

```text
tmux pane
  -> shellgate-broker.py
      -> child pty
          -> child shell
```

For a new managed tmux session:

```text
/shellgate tmux shellgate-managed /path
/shellgate ssh-tmux host shellgate-managed /path
```

For an existing visible pane, use explicit adopt:

```text
/shellgate tmux %88 /path --adopt
/shellgate ssh-tmux host %88 /path --adopt
```

Adopt starts a short launcher in the existing pane shell. The broker inherits that shell's exported environment and `$SHELL`, then user keystrokes and agent tools cowork in the broker-managed child shell. The original pane shell is not used as the command execution backend.

When the agent is not running a transaction, the pty belongs to the real child shell. If the local shell is zsh, the user sees and interacts with zsh. Agent transactions briefly send internal `__SGB_*` boundaries through the child shell so ShellGate can recover exit code and cwd, then return to normal interactive shell use.

For interactive programs such as `pdb`, the broker detects terminal-input waits and returns immediately without killing the program. The agent can send explicit input with `shellgate_input`, which writes through the broker socket to the child pty and returns the output delta captured after that input. It does not use `tmux send-keys` or attach helpers. When the managed shell is idle, `shellgate_input` returns `sent:false` by default instead of writing debugger commands into the shell; pass `force:true` only for intentional raw input.

## Notes

- `tmux` and `tmux-managed` are equivalent broker-managed local tmux modes.
- `ssh-tmux` and `ssh-tmux-managed` are equivalent broker-managed remote tmux modes.
- `/shellgate off` clears routing and asks the active managed broker to shut down.
- Broker launches use `--history off` by default. This only prefixes ShellGate agent transaction lines with a leading space; it does not force zsh/bash-specific shell options.
- ShellGate does not inject the old `__sg_*` attach helper/status protocol into the user's original pane shell.
- File tools show short labels in the managed pane, such as `[shellgate] write /path/file (4 bytes)`, and hide base64/heredoc transport.
- For SSH, OpenSSH ControlMaster settings in `~/.ssh/config` can reuse existing SSH connections automatically.
- See `docs/known-limitations.md` for current broker-mode boundaries.
- See `docs/test-baseline.md` for the manual broker regression checklist.

## Development

Core files:

```text
extensions/shellgate.ts
extensions/shellgate-broker.py
package.json
README.md
```

Test locally:

```bash
pi -e ./extensions/shellgate.ts
```
