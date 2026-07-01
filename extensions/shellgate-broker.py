#!/usr/bin/env python3
import argparse
import base64
import errno
import json
import os
import pty
import select
import signal
import socket
import sys
import time
import tty
import termios
import fcntl

BROKER_BEGIN = "__SGB_BEGIN"
BROKER_STATUS = "__SGB_STATUS"
INPUT_WCHAN_FRAGMENTS = (
    "tty_read",
    "n_tty_read",
    "do_select",
    "do_poll",
    "ep_poll",
    "poll_schedule_timeout",
    "wait_woken",
)


def sh_quote(value: str) -> str:
    return "'" + value.replace("'", "'\\''") + "'"


def fish_quote(value: str) -> str:
    return "'" + value.replace("\\", "\\\\").replace("'", "\\'") + "'"


def shell_kind(shell: str) -> str:
    name = os.path.basename(shell or "")
    if name == "fish":
        return "fish"
    return "posix"


def command_block(kind: str, command: str, cwd, request_id: str, history: str) -> str:
    encoded = base64.b64encode(command.encode()).decode()
    prefix = "" if history == "on" else " "
    if kind == "fish":
        parts = [f"{prefix}printf '\\n{BROKER_BEGIN}_{fish_quote(request_id)}__\\n'"]
        if cwd:
            parts.append(f"cd {fish_quote(cwd)}")
        parts.extend([
            f"eval (printf %s {fish_quote(encoded)} | base64 -d)",
            "set -l __sgb_s $status",
            "set -l __sgb_c (pwd -P 2>/dev/null; or pwd)",
            "set -l __sgb_b (printf %s $__sgb_c | base64 | tr -d '\\n')",
            f"printf '\\n{BROKER_STATUS}_{fish_quote(request_id)}__:%s:%s\\n' $__sgb_s $__sgb_b",
            "",
        ])
        return "; ".join(parts) + "\n"
    parts = [f"{prefix}printf '\\n{BROKER_BEGIN}_{sh_quote(request_id)}__\\n'"]
    if cwd:
        parts.append(f"cd {sh_quote(cwd)}")
    parts.extend([
        f"eval \"$(printf %s {sh_quote(encoded)} | base64 -d)\"",
        "__sgb_s=$?",
        "__sgb_c=$(pwd -P 2>/dev/null||pwd)",
        "__sgb_b=$(printf %s \"$__sgb_c\"|base64|tr -d '\\n')",
        f"printf '\\n{BROKER_STATUS}_{sh_quote(request_id)}__:%s:%s\\n' \"$__sgb_s\" \"$__sgb_b\"",
        "unset __sgb_s __sgb_c __sgb_b",
        "",
    ])
    return "; ".join(parts) + "\n"


def set_nonblocking(fd: int) -> None:
    flags = fcntl.fcntl(fd, fcntl.F_GETFL)
    fcntl.fcntl(fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)


def write_all(fd: int, data: bytes, timeout: float = 5.0) -> bool:
    deadline = time.time() + timeout
    view = memoryview(data)
    while view:
        try:
            written = os.write(fd, view)
            if written <= 0:
                return False
            view = view[written:]
        except BlockingIOError:
            if time.time() >= deadline:
                return False
            select.select([], [fd], [], min(0.05, max(0.0, deadline - time.time())))
        except OSError as exc:
            if exc.errno in (errno.EAGAIN, errno.EWOULDBLOCK):
                if time.time() >= deadline:
                    return False
                select.select([], [fd], [], min(0.05, max(0.0, deadline - time.time())))
                continue
            return False
    return True


def copy_winsize(src_fd: int, dst_fd: int) -> None:
    try:
        data = fcntl.ioctl(src_fd, termios.TIOCGWINSZ, b"\0" * 8)
        fcntl.ioctl(dst_fd, termios.TIOCSWINSZ, data)
    except Exception:
        pass


def read_text(path: str) -> str:
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            return fh.read().strip()
    except Exception:
        return ""


def read_process_stat(pid: int):
    data = read_text(f"/proc/{pid}/stat")
    if not data:
        return None
    left = data.find("(")
    right = data.rfind(")")
    if left < 0 or right < left:
        return None
    fields = data[right + 2:].split()
    if len(fields) < 6:
        return None
    try:
        return {
            "pid": pid,
            "command": data[left + 1:right],
            "state": fields[0],
            "ppid": int(fields[1]),
            "pgrp": int(fields[2]),
            "session": int(fields[3]),
            "tty_nr": int(fields[4]),
            "tpgid": int(fields[5]),
        }
    except Exception:
        return None


def read_cmdline(pid: int, fallback: str) -> str:
    try:
        data = open(f"/proc/{pid}/cmdline", "rb").read().replace(b"\0", b" ").decode(errors="replace").strip()
        return data or fallback
    except Exception:
        return fallback


def process_infos():
    infos = {}
    for name in os.listdir("/proc"):
        if not name.isdigit():
            continue
        info = read_process_stat(int(name))
        if info:
            infos[info["pid"]] = info
    return infos


def is_input_wchan(wchan: str) -> bool:
    if not wchan or wchan in ("0", "-"):
        return False
    return any(fragment in wchan for fragment in INPUT_WCHAN_FRAGMENTS)


class Broker:
    def __init__(self, socket_path: str, cwd: str, shell: str, history: str):
        self.socket_path = socket_path
        self.cwd = cwd
        self.shell = shell or os.environ.get("SHELL") or "/bin/sh"
        self.kind = shell_kind(self.shell)
        self.history = history if history in ("off", "on") else "off"
        self.master_fd = -1
        self.child_pid = -1
        self.slave_name = ""
        self.server = None
        self.clients = {}
        self.active = None
        self.interactive = None
        self.input_capture = None
        self.active_lines = []
        self.pending_line = ""
        self.original_tty = None
        self.should_exit = False

    def spawn_shell(self):
        pid, fd = pty.fork()
        if pid == 0:
            os.chdir(self.cwd)
            env = os.environ.copy()
            env.setdefault("TERM", "xterm-256color")
            argv0 = os.path.basename(self.shell)
            os.execvpe(self.shell, [argv0], env)
        self.child_pid = pid
        self.master_fd = fd
        try:
            self.slave_name = os.ptsname(self.master_fd)
        except Exception:
            self.slave_name = ""
        set_nonblocking(self.master_fd)
        copy_winsize(sys.stdin.fileno(), self.master_fd)

    def setup_socket(self):
        try:
            os.unlink(self.socket_path)
        except FileNotFoundError:
            pass
        self.server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.server.bind(self.socket_path)
        os.chmod(self.socket_path, 0o600)
        self.server.listen(8)
        self.server.setblocking(False)

    def set_child_echo(self, enabled: bool):
        try:
            attrs = termios.tcgetattr(self.master_fd)
            if enabled:
                attrs[3] |= termios.ECHO
            else:
                attrs[3] &= ~termios.ECHO
            termios.tcsetattr(self.master_fd, termios.TCSANOW, attrs)
        except Exception:
            pass

    def setup_terminal(self):
        try:
            self.original_tty = termios.tcgetattr(sys.stdin.fileno())
            tty.setraw(sys.stdin.fileno())
        except Exception:
            self.original_tty = None

    def restore_terminal(self):
        if self.original_tty is not None:
            try:
                termios.tcsetattr(sys.stdin.fileno(), termios.TCSADRAIN, self.original_tty)
            except Exception:
                pass

    def accept_client(self):
        conn, _ = self.server.accept()
        conn.setblocking(False)
        self.clients[conn.fileno()] = {"socket": conn, "buffer": b""}

    def handle_client(self, fd: int):
        state = self.clients[fd]
        conn = state["socket"]
        try:
            data = conn.recv(65536)
        except BlockingIOError:
            return
        if not data:
            self.close_client(fd)
            return
        state["buffer"] += data
        while b"\n" in state["buffer"]:
            line, state["buffer"] = state["buffer"].split(b"\n", 1)
            if not line.strip():
                continue
            try:
                request = json.loads(line.decode())
                if request.get("action") == "ping":
                    self.send_response(conn, {
                        "ok": True,
                        "broker": "shellgate",
                        "cwd": self.cwd,
                        "child_pid": self.child_pid,
                        "interactive": self.interactive,
                        "capabilities": ["input", "input-delta", "interactive-wait"],
                    })
                    continue
                if request.get("action") == "input":
                    self.handle_input_request(conn, request)
                    continue
                if request.get("action") == "shutdown":
                    self.send_response(conn, {"ok": True, "state": "shutting-down"})
                    self.should_exit = True
                    continue
                self.start_command(conn, request)
            except Exception as exc:
                self.send_response(conn, {"ok": False, "error": str(exc)})

    def close_client(self, fd: int):
        state = self.clients.pop(fd, None)
        if state:
            try:
                state["socket"].close()
            except Exception:
                pass

    def start_command(self, conn, request):
        if self.active is not None:
            self.send_response(conn, {"ok": False, "error": "broker is already running a command"})
            return
        if self.interactive is not None:
            wait = self.detect_interactive_wait()
            if wait:
                self.interactive["process"] = wait
                self.send_response(conn, {"ok": False, "error": self.interactive_error(wait), "interactive": wait})
                return
            foreground = self.foreground_external_process()
            if foreground:
                self.send_response(conn, {"ok": False, "error": self.foreground_error(foreground), "interactive": foreground})
                return
            self.interactive = None
        else:
            wait = self.detect_interactive_wait()
            if wait:
                self.send_response(conn, {"ok": False, "error": self.interactive_error(wait), "interactive": wait})
                return
            foreground = self.foreground_external_process()
            if foreground:
                self.send_response(conn, {"ok": False, "error": self.foreground_error(foreground), "interactive": foreground})
                return
        command = request.get("command")
        if not isinstance(command, str) or not command:
            self.send_response(conn, {"ok": False, "error": "command is required"})
            return
        display = request.get("display") if isinstance(request.get("display"), str) and request.get("display") else command
        cwd = request.get("cwd") if isinstance(request.get("cwd"), str) else None
        request_id = request.get("id") if isinstance(request.get("id"), str) else str(int(time.time() * 1000))
        timeout = request.get("timeout") if isinstance(request.get("timeout"), (int, float)) else None
        self.active = {
            "id": request_id,
            "client": conn,
            "cwd": cwd,
            "deadline": time.time() + timeout if timeout else None,
            "collecting": False,
            "visible_output": request.get("visible_output") is not False,
        }
        self.active_lines = []
        self.pending_line = ""
        self.interactive = None
        self.set_child_echo(False)
        write_all(sys.stdout.fileno(), f"\r\n[shellgate] {display}\r\n".encode(errors="replace"))
        os.write(self.master_fd, command_block(self.kind, command, cwd, request_id, self.history).encode())

    def send_response(self, conn, response):
        try:
            conn.sendall((json.dumps(response, separators=(",", ":")) + "\n").encode())
        except Exception:
            pass

    def handle_input_request(self, conn, request):
        text = request.get("text") if isinstance(request.get("text"), str) else ""
        key = request.get("key") if isinstance(request.get("key"), str) else ""
        enter = request.get("enter")
        if enter is None:
            enter = bool(text)
        payload = text.encode(errors="replace")
        if key:
            key_map = {
                "Enter": b"\r",
                "C-c": b"\x03",
                "C-d": b"\x04",
                "C-z": b"\x1a",
                "Esc": b"\x1b",
                "Tab": b"\t",
                "Backspace": b"\x7f",
                "Up": b"\x1b[A",
                "Down": b"\x1b[B",
                "Right": b"\x1b[C",
                "Left": b"\x1b[D",
            }
            if key not in key_map:
                self.send_response(conn, {"ok": False, "error": f"unsupported key: {key}"})
                return
            payload += key_map[key]
        if enter:
            payload += b"\r"
        if not payload:
            self.send_response(conn, {"ok": False, "error": "text or key is required"})
            return
        if self.input_capture is not None:
            self.send_response(conn, {"ok": False, "error": "broker is already collecting interactive input output"})
            return
        force = request.get("force") is True
        process = self.detect_interactive_wait() or self.foreground_external_process()
        if not force and process is None:
            self.send_response(conn, {
                "ok": True,
                "state": "shell-ready",
                "sent": False,
                "stdout_b64": "",
                "interactive": None,
                "cwd": self.cwd,
                "message": "managed child shell is idle; pass force=true to send input anyway",
            })
            return
        try:
            now = time.time()
            self.input_capture = {
                "client": conn,
                "buffer": "",
                "started": now,
                "last_output": now,
                "deadline": now + float(request.get("timeout", 5) if isinstance(request.get("timeout"), (int, float)) else 5),
                "quiet_after": float(request.get("quiet_after", 0.3) if isinstance(request.get("quiet_after"), (int, float)) else 0.3),
                "min_wait": float(request.get("min_wait", 0.15) if isinstance(request.get("min_wait"), (int, float)) else 0.15),
                "process": process,
            }
            os.write(self.master_fd, payload)
        except Exception as exc:
            self.input_capture = None
            self.send_response(conn, {"ok": False, "error": str(exc)})

    def complete_active(self, code: int, cwd: str):
        if self.active is None:
            return
        output = "".join(self.active_lines).replace("\r\n", "\n").replace("\r", "")
        response = {
            "ok": True,
            "code": code,
            "cwd": cwd,
            "stdout_b64": base64.b64encode(output.encode()).decode(),
            "stderr_b64": "",
        }
        self.cwd = cwd or self.cwd
        self.set_child_echo(True)
        self.send_response(self.active["client"], response)
        self.active = None
        self.active_lines = []
        self.pending_line = ""

    def process_pty_text(self, text: str):
        if self.active is None:
            if self.interactive is not None:
                self.process_interactive_text(text)
                return
            if text:
                write_all(sys.stdout.fileno(), text.encode(errors="replace"))
                self.append_input_capture(text)
            return
        self.pending_line += text
        while "\n" in self.pending_line:
            line, self.pending_line = self.pending_line.split("\n", 1)
            full_line = line + "\n"
            begin_prefix = f"{BROKER_BEGIN}_{self.active['id']}__"
            if begin_prefix in line:
                self.active["collecting"] = True
                continue
            status_prefix = f"{BROKER_STATUS}_{self.active['id']}__:"
            if status_prefix in line:
                status_text = line.split(status_prefix, 1)[1].strip().split(":", 2)
                try:
                    code = int(status_text[0])
                except Exception:
                    code = 1
                cwd = self.active.get("cwd") or self.cwd
                if len(status_text) > 1:
                    try:
                        cwd = base64.b64decode(status_text[1]).decode()
                    except Exception:
                        pass
                self.complete_active(code, cwd)
                continue
            if not self.active.get("collecting"):
                continue
            if BROKER_STATUS in line and self.active["id"] in line:
                continue
            if BROKER_BEGIN in line and self.active["id"] in line:
                continue
            if self.active.get("visible_output"):
                display_line = full_line.replace("\r", "").replace("\n", "\r\n")
                write_all(sys.stdout.fileno(), display_line.encode(errors="replace"))
            self.active_lines.append(full_line)

    def handle_pty(self):
        try:
            data = os.read(self.master_fd, 4096)
        except BlockingIOError:
            return
        if not data:
            raise SystemExit(0)
        self.process_pty_text(data.decode(errors="replace"))

    def append_input_capture(self, text: str):
        if self.input_capture is None or not text:
            return
        current = self.input_capture.get("buffer", "") + text
        if len(current) > 65536:
            current = current[-65536:]
        self.input_capture["buffer"] = current
        self.input_capture["last_output"] = time.time()

    def process_interactive_text(self, text: str):
        if "__SGB" not in text and not self.pending_line:
            write_all(sys.stdout.fileno(), text.encode(errors="replace"))
            self.append_input_capture(text)
            return
        self.pending_line += text
        while "\n" in self.pending_line:
            line, self.pending_line = self.pending_line.split("\n", 1)
            full_line = line + "\n"
            status_prefix = f"{BROKER_STATUS}_{self.interactive['id']}__:" if self.interactive else ""
            if status_prefix and status_prefix in line:
                status_text = line.split(status_prefix, 1)[1].strip().split(":", 2)
                cwd = self.cwd
                if len(status_text) > 1:
                    try:
                        cwd = base64.b64decode(status_text[1]).decode()
                    except Exception:
                        pass
                self.cwd = cwd or self.cwd
                self.interactive = None
                self.pending_line = ""
                continue
            begin_prefix = f"{BROKER_BEGIN}_{self.interactive['id']}__" if self.interactive else ""
            if begin_prefix and begin_prefix in line:
                continue
            write_all(sys.stdout.fileno(), full_line.encode(errors="replace"))
            self.append_input_capture(full_line)
        if self.pending_line and "__SGB" not in self.pending_line:
            write_all(sys.stdout.fileno(), self.pending_line.encode(errors="replace"))
            self.append_input_capture(self.pending_line)
            self.pending_line = ""

    def handle_stdin(self):
        try:
            data = os.read(sys.stdin.fileno(), 4096)
        except BlockingIOError:
            return
        if not data:
            raise SystemExit(0)
        # During an agent command, queueing user input would be safer but much more
        # surprising. First implementation keeps cowork literal: both sources feed
        # the managed shell. Users should avoid typing during agent transactions.
        os.write(self.master_fd, data)

    def complete_input_capture(self, state: str, process=None):
        if self.input_capture is None:
            return
        capture = self.input_capture
        output = str(capture.get("buffer", "")).replace("\r\n", "\n").replace("\r", "")
        response = {
            "ok": True,
            "state": state,
            "sent": True,
            "stdout_b64": base64.b64encode(output.encode()).decode(),
            "interactive": process or self.interactive or capture.get("process"),
            "cwd": self.cwd,
        }
        self.send_response(capture["client"], response)
        self.input_capture = None

    def check_input_capture(self):
        if self.input_capture is None:
            return
        now = time.time()
        output_seen = bool(self.input_capture.get("buffer", ""))
        waited_long_enough = now - self.input_capture.get("started", now) >= self.input_capture.get("min_wait", 0.08)
        wait = self.detect_interactive_wait()
        if wait and (output_seen or waited_long_enough):
            if self.interactive is not None:
                self.interactive["process"] = wait
            self.complete_input_capture("interactive-wait", wait)
            return
        foreground = self.foreground_external_process()
        if foreground:
            if now > self.input_capture.get("deadline", now):
                self.complete_input_capture("foreground-running", foreground)
            return
        quiet_after = self.input_capture.get("quiet_after", 0.3)
        if now - self.input_capture.get("last_output", now) >= quiet_after:
            self.interactive = None
            self.complete_input_capture("shell-ready", None)

    def check_timeout(self):
        if not self.active:
            return
        deadline = self.active.get("deadline")
        if deadline and time.time() > deadline:
            self.set_child_echo(True)
            self.send_response(self.active["client"], {"ok": False, "error": "timeout"})
            self.active = None
            self.active_lines = []
            self.pending_line = ""

    def check_interactive_wait(self):
        if not self.active:
            return
        now = time.time()
        last = self.active.get("last_wait_check", 0)
        if now - last < 0.15:
            return
        self.active["last_wait_check"] = now
        wait = self.detect_interactive_wait()
        if not wait:
            return
        if self.pending_line and self.active.get("visible_output"):
            write_all(sys.stdout.fileno(), self.pending_line.replace("\r", "").encode(errors="replace"))
        output = "".join(self.active_lines) + self.pending_line
        self.interactive = {"id": self.active["id"], "process": wait}
        response = {
            "ok": False,
            "error": self.interactive_error(wait),
            "interactive": wait,
            "cwd": self.cwd,
            "stdout_b64": base64.b64encode(output.encode()).decode(),
            "stderr_b64": "",
        }
        self.set_child_echo(True)
        self.send_response(self.active["client"], response)
        self.active = None
        self.active_lines = []
        self.pending_line = ""

    def foreground_pgrp(self):
        try:
            return os.tcgetpgrp(self.master_fd)
        except Exception:
            return -1

    def descendant_pids(self, infos):
        children = {}
        for pid, info in infos.items():
            children.setdefault(info["ppid"], []).append(pid)
        result = set()
        stack = list(children.get(self.child_pid, []))
        while stack:
            pid = stack.pop()
            if pid in result:
                continue
            result.add(pid)
            stack.extend(children.get(pid, []))
        return result

    def fds_to_slave(self, pid: int):
        if not self.slave_name:
            return []
        result = []
        fd_dir = f"/proc/{pid}/fd"
        try:
            names = os.listdir(fd_dir)
        except Exception:
            return []
        slave_real = os.path.realpath(self.slave_name)
        for name in names:
            try:
                target = os.path.realpath(os.readlink(os.path.join(fd_dir, name)))
            except Exception:
                continue
            if target == slave_real:
                try:
                    result.append(int(name))
                except Exception:
                    pass
        return sorted(result)

    def process_record(self, info, wchan: str, fds):
        return {
            "pid": info["pid"],
            "command": read_cmdline(info["pid"], info["command"]),
            "wchan": wchan,
            "pgrp": info["pgrp"],
            "tpgid": info["tpgid"],
            "tty_fds": fds,
        }

    def detect_interactive_wait(self):
        foreground = self.foreground_pgrp()
        if foreground <= 0:
            return None
        infos = process_infos()
        for pid in sorted(self.descendant_pids(infos)):
            if pid == self.child_pid:
                continue
            info = infos.get(pid)
            if not info or info["pgrp"] != foreground:
                continue
            fds = self.fds_to_slave(pid)
            if 0 not in fds:
                continue
            wchan = read_text(f"/proc/{pid}/wchan")
            if not is_input_wchan(wchan):
                continue
            return self.process_record(info, wchan, fds)
        return None

    def foreground_external_process(self):
        foreground = self.foreground_pgrp()
        if foreground <= 0:
            return None
        infos = process_infos()
        for pid in sorted(self.descendant_pids(infos)):
            if pid == self.child_pid:
                continue
            info = infos.get(pid)
            if not info or info["pgrp"] != foreground:
                continue
            fds = self.fds_to_slave(pid)
            if 0 not in fds:
                continue
            wchan = read_text(f"/proc/{pid}/wchan") or "unknown"
            return self.process_record(info, wchan, fds)
        return None

    def interactive_error(self, process) -> str:
        return (
            "managed child shell foreground process is waiting for terminal input: "
            f"pid {process['pid']}, {process['command']}, wchan={process['wchan']}, "
            f"pgrp={process['pgrp']}, tpgid={process['tpgid']}, tty_fds={','.join(str(fd) for fd in process['tty_fds'])}; "
            "program left running in the managed pane"
        )

    def foreground_error(self, process) -> str:
        return (
            "managed child shell is still running a foreground process: "
            f"pid {process['pid']}, {process['command']}, wchan={process['wchan']}; "
            "wait for it to return to the shell before sending another tool command"
        )

    def run(self):
        self.spawn_shell()
        self.setup_socket()
        signal.signal(signal.SIGWINCH, lambda *_: copy_winsize(sys.stdin.fileno(), self.master_fd))
        self.setup_terminal()
        set_nonblocking(sys.stdin.fileno())
        try:
            while not self.should_exit:
                fds = [self.master_fd, sys.stdin.fileno(), self.server.fileno(), *self.clients.keys()]
                ready, _, _ = select.select(fds, [], [], 0.1)
                for fd in ready:
                    if fd == self.master_fd:
                        self.handle_pty()
                    elif fd == sys.stdin.fileno():
                        self.handle_stdin()
                    elif fd == self.server.fileno():
                        self.accept_client()
                    else:
                        self.handle_client(fd)
                self.check_interactive_wait()
                self.check_input_capture()
                self.check_timeout()
        finally:
            self.restore_terminal()
            try:
                if self.child_pid > 0:
                    os.kill(self.child_pid, signal.SIGHUP)
            except Exception:
                pass
            try:
                os.unlink(self.socket_path)
            except Exception:
                pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--socket", required=True)
    parser.add_argument("--cwd", required=True)
    parser.add_argument("--shell", default=os.environ.get("SHELL") or "/bin/sh")
    parser.add_argument("--history", choices=["off", "on"], default="off")
    args = parser.parse_args()
    Broker(args.socket, args.cwd, args.shell, args.history).run()


if __name__ == "__main__":
    main()
