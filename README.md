# pi-shellgate

ShellGate is a [pi](https://pi.dev/) extension that routes the agent's normal `bash`, `read`, `write`, and `edit` tools through a selected shell backend.

Supported backends:

- Local directory
- SSH host
- Local tmux pane/session
- SSH tmux pane/session
- Docker-through-tmux (`docker exec -it <container> bash/sh` inside a tmux pane)

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
/shellgate tmux session-or-pane [/path]
/shellgate ssh-tmux host session-or-pane [/path]
```

Alias:

```text
/sg ssh host:/path
```

Natural language should also work because the extension registers `shellgate_connect` and prompt guidance:

```text
Please ssh to 192.168.201.15:/home/ylang/project and do the rest of the work there.
```

After connection, the agent should use ordinary tools, not wrap every command in `ssh`, `tmux`, or `docker exec`.

## Docker-through-tmux

Open or reuse a visible tmux pane and enter a container:

```bash
docker exec -it <container> bash
# or: docker exec -it <container> sh
```

Then connect ShellGate to that pane:

```text
/shellgate tmux %42
```

After that, normal `bash`, `read`, `write`, and `edit` calls run inside the container shell.

## Notes

- When a user is observing, ShellGate guidance tells the agent to prefer a user-visible/current pi tmux session or pane.
- For tmux targets, ShellGate resolves the target to a stable pane id such as `%42`.
- For SSH, OpenSSH ControlMaster settings in `~/.ssh/config` can reuse existing SSH connections automatically.
- See `docs/known-limitations.md` for tmux backend edge cases, including `exit`, prompt marker collisions, and stderr/stdout merging.

## Development

This is a single-file pi package:

```text
extensions/shellgate.ts
package.json
README.md
```

Test locally:

```bash
pi -e ./extensions/shellgate.ts
```
