# Known Limitations

ShellGate routes normal pi tools through SSH, tmux, SSH-tmux, and Docker-through-tmux backends. The tmux backend intentionally uses a visible interactive pane, which keeps behavior close to the shell the user is watching but also creates a few known edge cases.

## Tmux Backend

### `exit` and `exec` can close the target pane

The tmux backend runs commands in the pane's real interactive shell so shell state behaves naturally. This means commands such as `cd`, `source`, `export`, and shell builtins affect the pane just as if the user typed them.

The tradeoff is that commands which terminate or replace the current shell can close or take over the pane:

```sh
exit 7
exec bash
```

Observed impact:

- Direct `exit` can close the target tmux pane.
- ShellGate may then report an error such as `can't find pane: %65`.
- This is a tmux-only edge case; local and SSH backends execute commands in child processes.

Recommended agent behavior:

- Do not run direct `exit` or `exec` in tmux backends unless the user explicitly asks to close or replace the pane shell.
- To test an exit code, wrap it in a child process explicitly:
  ```sh
  ( exit 7 )
  bash -lc 'exit 7'
  ```

### Interactive wait detection is conservative

When a tmux command has not completed, ShellGate checks process state without parsing terminal output. It only reports a high-confidence input wait when all of these are true:

- The process is a descendant of the pane shell.
- The process is in the pane's foreground process group.
- One of the process file descriptors points at the pane tty.
- The process `wchan` looks input-related, such as `tty_read`, `n_tty_read`, `do_select`, `do_poll`, `ep_poll`, or `wait_woken`.

This catches many direct terminal-input waits, including Python `input()`, `pdb`, and programs using `select(stdin)`. When this happens, ShellGate now returns immediately and leaves the program running in the target shell; use `shellgate_send` to send debugger/input commands. It intentionally excludes the pane shell process itself because an idle shell prompt can look like `do_poll` on the pane tty and would otherwise cause false positives. As a result, shell builtins such as `read secret` can still fall back to the normal command timeout. It also does not claim to detect every interactive prompt. For example, `sudo` may appear as `wchan=0` or `WCHAN -`, and its file descriptors may be unreadable; in that case ShellGate treats the state as unknown rather than claiming it is waiting for a password.

### Prompt/control marker collisions can hide real output

The tmux parser filters prompt-mode control lines so tool output stays clean. By default ShellGate also attempts to remove internal setup/status protocol lines from the current visible screen after they have been captured and parsed.

When `SHELLGATE_DEBUG=1` is set in the pi extension process, ShellGate leaves internal protocol lines visible for debugging. The helper uses ShellGate's injected internal `__sg_debug` value, so a stale `SHELLGATE_DEBUG` variable inside the target shell should not affect hiding. Debug-visible protocol includes:

```text
shellgate$ ...
shellgate> ...
--- ShellGate setup ready: helpers installed; /shellgate clean removes them ---
shellgate$ __sg_status ...
__SG_STATUS_...:0:...
```

`shellgate$ ` is the primary prompt for a new command, similar to the conventional `$` prompt. `shellgate> ` is the continuation prompt used when the shell is waiting for the rest of a multiline input, similar to the conventional `>` prompt.

Observed impact:

- A real program output line beginning with `shellgate$ ` or `shellgate> ` can be omitted from the tool result.
- A real program output line containing `shellgate$ __sg_status ` can be truncated.
- Current-screen hiding does not erase tmux scrollback/history.
- File transfer tools are not affected in the same way; `read`, `write`, and `edit` can preserve these strings in file contents.

Preferred fix direction:

- Replace fixed human-readable prompt markers with high-entropy per-session or per-command markers.
- Filter only exact markers associated with the active command id.
- Prefer explicit begin/end/status boundaries over broad prompt-looking line filters.

### stdout and stderr are merged

The tmux backend captures terminal output with `tmux capture-pane`. By the time output reaches the pane, stdout and stderr are already merged by the pseudo-terminal.

Observed impact:

- stderr appears in the tool's output stream together with stdout.
- Exit codes are still captured separately.
- This differs from local process execution, where stdout and stderr can be separated.

Preferred fix direction:

- Keep this as a documented limitation unless strict fd separation is required.
- If needed, execute commands through an internal child shell that redirects stdout and stderr to separate temporary files or marker-delimited channels.
- Balance stricter fd separation against extra visible pane noise and implementation complexity.
