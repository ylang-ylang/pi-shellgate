# Known Limitations

ShellGate routes normal pi tools through SSH, tmux, SSH-tmux, and Docker-through-tmux backends. The tmux backend intentionally uses a visible interactive pane, which keeps behavior close to the shell the user is watching but also creates a few known edge cases.

## Tmux Backend

### `exit` can close the target pane

Current prompt-mode tmux execution pastes the command block directly into the target interactive shell:

```sh
cd '<cwd>'
<user command>
__sg_status '<id>'
```

Because the user command runs in the pane's real interactive shell, commands such as `exit`, `logout`, or some `exec ...` forms can terminate that shell. When the shell exits, tmux closes the pane before ShellGate can run the status marker.

Observed impact:

- `exit 7` closes the target tmux pane.
- ShellGate then reports an error such as `can't find pane: %62`.
- This is a destructive tmux-only edge case; local and SSH backends execute commands in child processes.

Preferred fix direction:

- Run user commands in a child shell inside the pane instead of the pane's parent interactive shell.
- Preserve cwd by having the child shell report its final cwd, then applying that cwd in the parent pane shell after the child exits.
- Avoid reintroducing the old large base64 script wrapper as the default path.

### Prompt/control marker collisions can hide real output

The current tmux parser filters visible prompt-mode control lines so tool output stays clean. It removes lines that look like ShellGate prompts or setup/status markers, including:

```text
shellgate$ ...
shellgate> ...
--- ShellGate setup ready: helpers installed; /shellgate clean removes them ---
```

`shellgate$ ` is the primary prompt for a new command, similar to the conventional `$` prompt. `shellgate> ` is the continuation prompt used when the shell is waiting for the rest of a multiline input, similar to the conventional `>` prompt.

It also truncates a line at an inline control tail such as:

```text
shellgate$ __sg_status ...
```

Observed impact:

- A real program output line beginning with `shellgate$ ` or `shellgate> ` can be omitted from the tool result.
- A real program output line containing `shellgate$ __sg_status ` can be truncated.
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
