# ShellGate Project Direction

ShellGate's tmux product direction is fully broker-managed child shells.

Default rules:

- Do not reintroduce tmux attach as a normal implementation path.
- Do not inject normal agent commands into the user's original pane shell.
- All tmux modes (`tmux`, `tmux-managed`, `ssh-tmux`, `ssh-tmux-managed`) mean broker-managed child shell.
- The original pane shell may be used only once as an explicit `--adopt` launcher for the broker.

Target managed architecture:

```text
tmux pane
  -> shellgate broker
      -> managed child pty
          -> managed child shell
```

Explicit adoption of an existing visible pane such as `%88`:

```text
tmux pane %88
  -> original shell only launches broker
      -> shellgate broker as foreground program
          -> managed child pty
              -> managed child shell
```

The managed child shell should behave like a real system shell when the agent is idle. If the inherited `$SHELL` is `/usr/bin/zsh`, the child shell is zsh. The broker should relay user input and shell output directly outside active agent transactions.

Adopt inheritance contract:

- The broker is launched by the existing pane shell so it can inherit exported environment variables and `$SHELL`.
- The child shell inherits the broker environment, cwd, TERM, window size, and shell path.
- It does not inherit aliases, shell functions, unexported variables, job table, readline state, or shell options.

Implementation rules:

- No `TmuxBackend` attach path in `extensions/shellgate.ts`.
- No attach-style `shellgate_send` tool.
- Broker-native interactive input must use `shellgate_input` through the broker socket, never `tmux send-keys`.
- `shellgate_input` must return captured output delta and must not write to an idle shell unless explicitly forced.
- No `__sg_on`, `__sg_status`, `__sg_clean`, or prompt-helper setup path.
- Broker-internal transaction markers must use the broker namespace, currently `__SGB_*`, not attach `__sg_*` names.
- File tools in managed mode should show short labels in the pane and must not expose base64/heredoc transport.
- Ordinary `bash` output in managed mode should remain visible in the broker-managed child shell.
- `/shellgate off` should send broker `shutdown` before clearing active state.
- Broker `--history off` must stay shell-agnostic: prefix generated transaction lines with a leading space, but do not force zsh/bash/fish history options.
