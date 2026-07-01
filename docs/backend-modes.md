# Backend Modes

ShellGate now treats tmux as a display and transport for a broker-managed child shell. It no longer exposes an attach backend for normal tool routing.

## Current Contract

Supported execution backends:

| Backend | Structured Results | Persistent Shell | Visible Pane | Notes |
| --- | --- | --- | --- | --- |
| Local | Yes | No | No | Runs commands through local child processes |
| SSH | Yes | No | No | Runs commands through SSH child processes |
| Tmux broker | Yes | Yes, broker child shell | Yes | User and agent cowork in a broker-managed pty |
| SSH tmux broker | Yes | Yes, remote broker child shell | Yes | Broker script is copied to the remote host |

All tmux command forms use the broker backend:

```text
/shellgate tmux session [/path] [--adopt]
/shellgate tmux-managed session [/path] [--adopt]
/shellgate ssh-tmux host session [/path] [--adopt]
/shellgate ssh-tmux-managed host session [/path] [--adopt]
```

`tmux` and `ssh-tmux` are compatibility aliases for the broker-managed modes. They do not mean attach.

## Broker Architecture

New managed tmux session:

```text
tmux pane
  -> shellgate-broker.py
      -> child pty
          -> child shell
```

Existing pane adoption:

```text
tmux pane
  -> original shell only launches broker
      -> shellgate-broker.py
          -> child pty
              -> child shell
```

The broker opens a Unix socket for agent requests and relays the pane tty to the child pty. When no agent command is active, the child shell behaves like a normal user shell. If `$SHELL` is `/usr/bin/zsh`, the managed shell is zsh.

When the agent sends a transaction, the broker writes a short command block into the child shell. The block contains internal `__SGB_*` begin/status markers so ShellGate can recover command output, exit code, and cwd. File tools request hidden visible output so base64/heredoc transport is not shown in the pane.

Broker launches pass `--history off` by default. That setting keeps ShellGate's own command block shell-agnostic by prefixing the generated transaction line with a leading space. It does not set zsh, bash, or fish-specific history options, and strict history suppression depends on the user's shell configuration.

For interactive foreground programs, ShellGate uses broker-native `shellgate_input` to write to the child pty through the broker socket and return the output delta captured after that input. It must not use `tmux send-keys` or attach helpers for agent-driven debugging. If the child shell is idle, `shellgate_input` returns `sent:false` unless `force:true` is supplied.

## Environment Inheritance

For newly created managed sessions, the broker inherits the environment of the pi extension process or remote SSH command.

For explicit `--adopt`, the broker is launched by the existing pane shell. That allows the broker and child shell to inherit exported environment variables and `$SHELL` from that pane shell. It still cannot inherit shell-private state such as aliases, functions, unexported variables, job table, shell options, or readline state.

## Removed Attach Mode

The previous attach implementation injected helper functions and status markers into the user's original pane shell. That path is removed from the main extension:

- no `TmuxBackend` in `extensions/shellgate.ts`
- no `shellgate_send` attach tool; broker-native input is `shellgate_input`
- no `__sg_on` / `__sg_status` / `__sg_clean` setup path
- old serialized `kind: "tmux"` state is ignored on restore

This removes the class of failures where ShellGate helper/status text is consumed by `pdb`, `python input()`, `sudo`, editors, or other foreground programs in the original pane shell.
