# Backend Modes

ShellGate has two different goals that are easy to confuse:

- Share the same visible shell that a user is already using.
- Return structured tool results such as command boundary, exit code, cwd, stdout, and stderr.

An existing tmux pane cannot provide both without shell cooperation. A tmux pane is a pseudo-terminal byte stream. `tmux send-keys`, `tmux paste-buffer`, `tmux capture-pane`, `tmux pipe-pane`, and tmux control mode can send input and observe terminal output, but they do not expose shell events such as command start, command completion, `$?`, parser state, or stdout/stderr identity.

If a command must run in the existing foreground shell and ShellGate must reliably learn exit status and cwd, that shell has to cooperate. Cooperation can be an in-band helper, one-shot wrapper, prompt hook, external socket, FIFO, or broker. Without that cooperation, ShellGate can only automate terminal input and observe terminal text.

## Matrix

| Mode | Shares Existing Shell State | Structured Results | Pane Display | Protocol Pollution | Runner | Best For |
| --- | --- | --- | --- | --- | --- | --- |
| A. Attach existing shell | Yes | Partial | Natural | Yes | No | Reusing the user's current tmux shell state |
| B. Managed shell / broker | No, only limited env/cwd inheritance | Yes | Natural | No parent-shell protocol, but has a broker | Yes | SSH-like reliability in a visible pane |
| C. Exec runner with observation | No | Yes | Observed pane is read-only; command output returns to tools | No pane protocol | Per command only | File ops, tests, batch commands while user debugs in tmux |
| D. Best-effort terminal | Yes | No | Natural | No | No | Human-like typing and screen reading |

## A. Attach Existing Shell

Attach mode connects to an existing tmux pane and runs commands in that pane's foreground shell. This keeps shell state natural: `cd`, `source`, `export`, aliases, shell functions, and prompt state belong to the same shell the user sees.

The cost is that ShellGate needs a shell-side transaction protocol. Current protocol commands include `__sg_on`, `__sg_off`, `__sg_status`, `__sg_h`, and `__sg_clean`. These commands are in-band terminal input. If they are injected while the pane foreground program is `pdb`, `python input()`, `sudo`, `vim`, a long-running process, or another interactive program, the program can consume them as user input.

Attach mode must therefore use a single state gate for all pane writes:

- `certified-shell-ready`: user commands and ShellGate protocol may be injected.
- `interactive-wait`: only explicit interactive input, such as `shellgate_send`, may be sent.
- `running`: no injection by default.
- `unknown`: no injection by default.

The existing wchan/fd process-state logic belongs in this mode. It identifies high-confidence interactive waits by checking foreground process group, descendant relationship, file descriptors pointing at the pane tty, and input-like `/proc/<pid>/wchan` values. It is a safety boundary, not a shell parser.

Attach mode cannot reliably separate stdout and stderr because both streams have already entered the pseudo-terminal and become one terminal transcript.

## B. Managed Shell / Broker

Managed mode starts a ShellGate-controlled broker or child shell in a visible pane. ShellGate owns the execution protocol and can return structured results more like SSH exec.

This is cleaner for command execution but it is not the same as attaching to the user's existing parent shell. It can inherit limited state such as cwd, exported environment, terminal size, and shell path, but it cannot fully inherit aliases, shell functions, unexported variables, job tables, shell options, or in-memory prompt state. Child shell changes also do not flow back into the parent shell without additional shell cooperation.

## C. Exec Runner With Observation

Exec-observe mode separates observation from execution:

- The tmux pane is read-only context. ShellGate may capture screen/log output and inspect process state.
- Agent tools execute through a structured backend such as local process, SSH exec, Docker exec, or nsenter.
- ShellGate never sends helper commands, status markers, `cd`, prompt changes, `C-c`, or cleanup commands into the observed pane.

This mode is appropriate when a user is interactively debugging in a pane, for example in `pdb`, while the agent reads files, edits code, runs tests, or inspects logs through a separate exec backend. It avoids the attach-mode failure class where `__sg_status` or other internal protocol enters the debugger.

The tradeoff is that exec commands do not share the observed foreground shell's internal state. They do not inherit aliases, shell functions, unexported variables, sourced virtualenv state, or current jobs from the pane shell. The configured exec cwd is used instead.

## D. Best-Effort Terminal

Best-effort terminal mode only types into and reads from the terminal. It does not try to provide reliable command boundaries, exit codes, cwd, or stdout/stderr separation.

This mode has the least machinery but does not satisfy normal `bash/read/write/edit` tool semantics. It is useful only when the goal is human-like terminal operation rather than structured execution.

## Product Contract

No single mode can provide all of these at once:

- Existing foreground shell state.
- Natural user interaction in the same pane.
- Reliable command boundary, exit code, cwd, stdout, and stderr.
- No shell-side protocol.
- No broker or runner.

ShellGate should expose the modes explicitly instead of pretending tmux attach is the same thing as SSH exec. Attach mode keeps the shared shell state and accepts a guarded shell protocol. Exec-observe mode keeps the pane clean and reliable for agent tools, but it does not share the pane shell's private state.
