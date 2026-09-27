#!/usr/bin/env python3
"""Route-B hosted deployment supervisor and lifecycle regressions.

The root supervisor owns one no-fork mount-namespace holder. The holder keeps
all fixed-path deployment, application, recovery, and cleanup work in that
namespace. The caller-facing sudo policy is mounted privately before it is
installed, so hosted-runner-wide sudo grants cannot satisfy application tests.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import select
import signal
import stat
import struct
import subprocess
import sys
import tempfile
import threading
import time


HOSTED_BROKER = "/usr/local/libexec/swooshz-s8/s8-sandbox-broker"
HOSTED_LAUNCHER = "/usr/local/libexec/swooshz-s8/s8-sandbox"
HOSTED_PRIVATE_ROOT = "/var/lib/swooshz/s8"
HOSTED_SUDOERS = "/etc/sudoers.d/swooshz-s8-broker"
APP_PROOF_RELATIVE = "scripts/s8/s8_application_boundary_proof.mts"
APP_HELPER_RELATIVE = "scripts/s8/s8_application_boundary_proof.sh"
APP_PROOF_BYTES = 9086
APP_PROOF_SHA256 = "34a86da59ae51a50501ffcde7fd2086a1ceeeb2258238962404f4a8ce9a3d0e8"
APP_HELPER_BYTES = 3328
APP_HELPER_SHA256 = "e594a8749645ef122f22a8bae852745f8c3492f9fcda35597301cdfd1b5e2c42"
LEAK_HOLDER_DEADLINE_SECONDS = 1.0
PROCESS_REAP_SECONDS = 5.0
BROKER_TEARDOWN_SECONDS = 35.0
ROOT_CLEANUP_SECONDS = 30.0
NAMESPACE_VERIFY_SECONDS = 10.0
CURRENT_RESULT_FD = -1
CURRENT_CANCEL_EVENT = None
ROOT_CANCEL_EVENT = threading.Event()


class SupervisorFailure(RuntimeError):
    pass


class Cancelled(SupervisorFailure):
    pass


def request_root_cancel(signum, frame):
    ROOT_CANCEL_EVENT.set()


def emit(fd, kind, **fields):
    payload = {"kind": kind, **fields}
    data = (json.dumps(payload, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
    offset = 0
    while offset < len(data):
        offset += os.write(fd, data[offset:])


def process_start_identity(pid):
    text = Path(f"/proc/{pid}/stat").read_text(encoding="ascii")
    rest = text.rsplit(")", 1)[1].strip().split()
    if len(rest) < 20 or not rest[19].isdigit():
        raise SupervisorFailure("PROCESS_START_IDENTITY_INVALID")
    boot_id = Path("/proc/sys/kernel/random/boot_id").read_text(encoding="ascii").strip()
    return f"{boot_id}:{pid}:{rest[19]}"


def namespace_identity(pid, name):
    path = Path(f"/proc/{pid}/ns/{name}")
    link = os.readlink(path)
    match = re.fullmatch(re.escape(name) + r":\[([0-9]+)\]", link)
    metadata = path.stat()
    if match is None:
        raise SupervisorFailure("NAMESPACE_IDENTITY_INVALID:" + name)
    return {"link": link, "inode": metadata.st_ino, "device": metadata.st_dev, "number": int(match.group(1))}


def process_uid_gid(pid):
    values = {}
    for line in Path(f"/proc/{pid}/status").read_text(encoding="ascii").splitlines():
        if line.startswith(("Uid:", "Gid:")):
            key, value = line.split(":", 1)
            values[key.lower()] = tuple(int(item) for item in value.split())
    if set(values) != {"uid", "gid"} or len(values["uid"]) != 4 or len(values["gid"]) != 4:
        raise SupervisorFailure("PROCESS_CREDENTIAL_READ_FAILED")
    return values["uid"], values["gid"]


def require_process_identity(owned, uid, gid, *, timeout=5.0):
    deadline = time.monotonic() + timeout
    expected_uid = (uid, uid, uid, uid)
    expected_gid = (gid, gid, gid, gid)
    while time.monotonic() < deadline:
        if not owned.identity_valid():
            break
        try:
            actual_uid, actual_gid = process_uid_gid(owned.pid)
        except (FileNotFoundError, ProcessLookupError):
            break
        if actual_uid == expected_uid and actual_gid == expected_gid:
            return
        time.sleep(0.01)
    if owned.identity_valid():
        terminate_owned(owned)
    raise SupervisorFailure("OWNED_PROCESS_IDENTITY_INVALID")


def write_ledger(path, value):
    line = (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode("ascii")
    descriptor = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != 0 or metadata.st_gid != 0 or stat.S_IMODE(metadata.st_mode) != 0o600 or metadata.st_nlink != 1:
            raise SupervisorFailure("PROCESS_LEDGER_IDENTITY_INVALID")
        written = os.write(descriptor, line)
        if written != len(line):
            raise SupervisorFailure("PROCESS_LEDGER_SHORT_WRITE")
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


class OwnedProcess:
    def __init__(self, process, owner, ledger_path, mount_id, start_identity, pidfd):
        self.process = process
        self.owner = owner
        self.pid = process.pid
        self.start_identity = start_identity
        self.pidfd = pidfd
        self.mount_id = mount_id
        self.terminal = None
        self._ledger_path = ledger_path
        write_ledger(ledger_path, {
            "event": "STARTED", "owner": owner, "pid": self.pid,
            "startIdentity": self.start_identity, "pidfd": "OPEN",
            "mountNamespace": mount_id,
        })

    def identity_valid(self):
        try:
            return process_start_identity(self.pid) == self.start_identity
        except (FileNotFoundError, ProcessLookupError, SupervisorFailure):
            return False

    def signal(self, signum, expected_identity=None):
        if expected_identity is not None and expected_identity != self.start_identity:
            return False
        if not self.identity_valid():
            return False
        try:
            signal.pidfd_send_signal(self.pidfd, signum)
        except ProcessLookupError:
            return False
        except OSError as error:
            raise SupervisorFailure("PIDFD_SIGNAL_FAILED") from error
        return True

    def wait(self, timeout):
        if self.terminal is not None:
            return self.terminal
        try:
            result = self.process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            return None
        self.terminal = result
        try:
            write_ledger(self._ledger_path, {
                "event": "TERMINAL", "owner": self.owner, "pid": self.pid,
                "startIdentity": self.start_identity,
                "mountNamespace": self.mount_id,
                "waitResult": {"kind": "EXITED", "status": result} if result >= 0 else {"kind": "SIGNALED", "signal": -result},
                "pidfd": "CLOSED_AFTER_WAIT",
            })
        finally:
            os.close(self.pidfd)
            self.pidfd = None
        return result


def launch_owned(argv, *, owner, ledger_path, mount_id=None, cwd=None, env=None, stdin=None, stdout=None, pass_fds=()):
    if not callable(getattr(os, "pidfd_open", None)) or not callable(getattr(signal, "pidfd_send_signal", None)):
        raise SupervisorFailure("PIDFD_UNAVAILABLE")
    process = subprocess.Popen(
        argv, cwd=cwd, env=env, stdin=subprocess.PIPE if stdin is not None else subprocess.DEVNULL,
        stdout=stdout if stdout is not None else subprocess.DEVNULL, stderr=subprocess.STDOUT,
        close_fds=True, pass_fds=tuple(pass_fds),
    )
    pidfd = None
    try:
        start_identity = process_start_identity(process.pid)
        pidfd = os.pidfd_open(process.pid, 0)
        if process_start_identity(process.pid) != start_identity:
            raise SupervisorFailure("OWNED_PROCESS_IDENTITY_CHANGED_DURING_LAUNCH")
        actual_mount_id = namespace_identity(process.pid, "mnt")["number"]
        owned = OwnedProcess(process, owner, ledger_path, actual_mount_id, start_identity, pidfd)
        pidfd = None
    except Exception:
        cleanup_error = None
        try:
            if process.poll() is None:
                if pidfd is not None:
                    try:
                        signal.pidfd_send_signal(pidfd, signal.SIGTERM)
                    except ProcessLookupError:
                        pass
                    except OSError:
                        try:
                            process.terminate()
                        except ProcessLookupError:
                            pass
                else:
                    # This is our unreaped direct child, so its PID cannot be reused.
                    try:
                        process.terminate()
                    except ProcessLookupError:
                        pass
                try:
                    process.wait(timeout=1)
                except subprocess.TimeoutExpired:
                    if pidfd is not None:
                        try:
                            signal.pidfd_send_signal(pidfd, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                        except OSError:
                            try:
                                process.kill()
                            except ProcessLookupError:
                                pass
                    else:
                        try:
                            process.kill()
                        except ProcessLookupError:
                            pass
                    process.wait(timeout=PROCESS_REAP_SECONDS)
            else:
                process.wait()
        except Exception as error:
            cleanup_error = error
        finally:
            if pidfd is not None:
                try:
                    os.close(pidfd)
                except OSError as error:
                    cleanup_error = cleanup_error or error
        if cleanup_error is not None:
            raise SupervisorFailure("OWNED_PROCESS_LAUNCH_CLEANUP_FAILED") from cleanup_error
        raise
    if mount_id is not None and actual_mount_id != mount_id:
        terminate_owned(owned)
        raise SupervisorFailure("OWNED_PROCESS_MOUNT_NAMESPACE_INVALID")
    if stdin is not None:
        try:
            process.stdin.write(stdin)
            process.stdin.close()
        except BrokenPipeError:
            pass
    return owned


def launch_owned_to_log(argv, *, log_path, **kwargs):
    with open(log_path, "wb", buffering=0) as output:
        return launch_owned(argv, stdout=output, **kwargs)


def wait_owned(owned, timeout):
    return owned.wait(timeout)


def terminate_owned(owned, *, grace=5.0):
    if owned.terminal is not None:
        return owned.terminal
    if not owned.signal(signal.SIGTERM, owned.start_identity):
        if owned.process.poll() is not None:
            return owned.wait(0)
        raise SupervisorFailure("OWNED_PROCESS_IDENTITY_MISMATCH")
    result = owned.wait(grace)
    if result is not None:
        return result
    if not owned.signal(signal.SIGKILL, owned.start_identity):
        if owned.process.poll() is not None:
            return owned.wait(0)
        raise SupervisorFailure("OWNED_PROCESS_IDENTITY_MISMATCH")
    result = owned.wait(grace)
    if result is None:
        raise SupervisorFailure("OWNED_PROCESS_REAP_TIMEOUT")
    return result


def supervised_command(argv, *, cwd=None, env=None, label="HOSTED_COMMAND_FAILED", log_path=None, timeout=None, cancel_event=None, stdin=None):
    ledger_path = os.environ.get("S8_PROCESS_LEDGER")
    if not ledger_path:
        completed = subprocess.run(argv, cwd=cwd, env=env, input=stdin, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=False, timeout=timeout)
        return completed
    mount_id = namespace_identity(os.getpid(), "mnt")["number"]
    temporary = None
    if log_path is None:
        temporary = tempfile.TemporaryFile()
        output = temporary
    else:
        output = open(log_path, "wb", buffering=0)
        os.chmod(log_path, 0o600)
    owned = None
    try:
        owned = launch_owned(argv, owner=f"broker-contract:{os.getpid()}", ledger_path=ledger_path, mount_id=mount_id, cwd=cwd, env=env, stdin=stdin, stdout=output)
        if cancel_event is None:
            cancel_event = CURRENT_CANCEL_EVENT
        deadline = None if timeout is None else time.monotonic() + timeout
        cancel_deadline = None
        term_deadline = None
        while owned.process.poll() is None:
            if cancel_event is not None and cancel_event.is_set():
                if cancel_deadline is None:
                    cancel_deadline = time.monotonic() + BROKER_TEARDOWN_SECONDS
                elif time.monotonic() >= cancel_deadline and term_deadline is None:
                    if not owned.signal(signal.SIGTERM, owned.start_identity):
                        raise SupervisorFailure("OWNED_PROCESS_IDENTITY_MISMATCH")
                    term_deadline = time.monotonic() + PROCESS_REAP_SECONDS
                elif term_deadline is not None and time.monotonic() >= term_deadline:
                    if not owned.signal(signal.SIGKILL, owned.start_identity):
                        raise SupervisorFailure("OWNED_PROCESS_IDENTITY_MISMATCH")
                    result = owned.wait(PROCESS_REAP_SECONDS)
                    if result is None:
                        raise SupervisorFailure("OWNED_PROCESS_REAP_TIMEOUT")
                    break
            if deadline is not None and time.monotonic() >= deadline:
                terminate_owned(owned)
                raise SupervisorFailure(label + ":TIMEOUT")
            time.sleep(0.05)
        returncode = owned.wait(PROCESS_REAP_SECONDS)
        if returncode is None:
            raise SupervisorFailure("OWNED_PROCESS_REAP_TIMEOUT")
        output.flush()
        if log_path is not None:
            output.close()
            data = Path(log_path).read_bytes()
        else:
            output.seek(0)
            data = output.read()
        if len(data) > 64 * 1024 * 1024:
            raise SupervisorFailure("HOSTED_COMMAND_OUTPUT_OVERSIZE")
        return subprocess.CompletedProcess(argv, returncode, stdout=data, stderr=b"")
    finally:
        if owned is not None and owned.terminal is None:
            if owned.process.poll() is None:
                terminate_owned(owned)
            else:
                owned.wait(0)
        if not output.closed:
            output.close()


def host_uid_gid(uid, gid):
    account = pwd.getpwuid(uid)
    if account.pw_gid != gid or not re.fullmatch(r"[a-z_][a-z0-9_-]*\$?", account.pw_name):
        raise SupervisorFailure("HOSTED_RUNNER_ACCOUNT_INVALID")
    return account


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        while True:
            block = stream.read(1024 * 1024)
            if not block:
                break
            digest.update(block)
    return digest.hexdigest()


def toolchain_identity(path):
    requested = Path(path)
    if not requested.is_absolute():
        raise SupervisorFailure("HOSTED_TOOLCHAIN_PATH_NOT_ABSOLUTE")
    resolved = requested.resolve(strict=True)
    metadata = resolved.stat()
    if not stat.S_ISREG(metadata.st_mode) or not os.access(resolved, os.X_OK):
        raise SupervisorFailure("HOSTED_TOOLCHAIN_EXECUTABLE_INVALID")
    return {"requested": str(requested), "resolved": str(resolved), "device": metadata.st_dev, "inode": metadata.st_ino, "mode": stat.S_IMODE(metadata.st_mode), "size": metadata.st_size, "sha256": sha256_file(resolved)}


def verify_toolchain(node, corepack, *, workspace, expected=None):
    node_identity = toolchain_identity(node)
    corepack_identity = toolchain_identity(corepack)
    if expected is not None and (node_identity != expected["node"] or corepack_identity != expected["corepack"]):
        raise SupervisorFailure("HOSTED_TOOLCHAIN_IDENTITY_CHANGED")
    host_uid = int(os.environ.get("S8_HOST_UID", str(os.getuid())))
    host_account = host_uid_gid(host_uid, pwd.getpwuid(host_uid).pw_gid)
    env = {"PATH": str(Path(node_identity["resolved"]).parent) + ":/usr/local/bin:/usr/bin:/bin", "HOME": host_account.pw_dir, "COREPACK_HOME": str(Path(host_account.pw_dir) / ".cache/node/corepack"), "COREPACK_ENABLE_AUTO_PIN": "0", "LC_ALL": "C"}
    node_result = supervised_command(app_identity_command(host_uid, host_account.pw_gid, [node_identity["resolved"], "--version"]), cwd=workspace, env=env, label="HOSTED_NODE_VERSION_FAILED")
    if node_result.returncode != 0 or not re.search(rb"(?m)^v22\.[0-9]+\.[0-9]+\s*$", node_result.stdout):
        raise SupervisorFailure("HOSTED_NODE_VERSION_INVALID")
    env["PATH"] = str(Path(corepack_identity["resolved"]).parent) + ":" + str(Path(node_identity["resolved"]).parent) + ":/usr/local/bin:/usr/bin:/bin"
    pnpm_result = supervised_command(app_identity_command(host_uid, host_account.pw_gid, [corepack_identity["resolved"], "pnpm@12.6.0", "--version"]), cwd=workspace, env=env, label="HOSTED_PNPM_VERSION_FAILED", timeout=120)
    if pnpm_result.returncode != 0 or pnpm_result.stdout.strip() != b"12.6.0":
        raise SupervisorFailure("HOSTED_PNPM_VERSION_INVALID")
    if toolchain_identity(node) != node_identity or toolchain_identity(corepack) != corepack_identity:
        raise SupervisorFailure("HOSTED_TOOLCHAIN_IDENTITY_CHANGED")
    return {"node": node_identity, "corepack": corepack_identity}


def mountinfo_rows():
    rows = []
    for line in Path("/proc/self/mountinfo").read_text(encoding="ascii").splitlines():
        fields = line.split()
        if "-" not in fields:
            raise SupervisorFailure("MOUNTINFO_MALFORMED")
        separator = fields.index("-")
        rows.append({"mountpoint": fields[4].replace("\\040", " ").replace("\\011", "\t").replace("\\134", "\\"), "optional": fields[6:separator], "fstype": fields[separator + 1], "source": fields[separator + 2], "raw": line})
    return rows


def mount_namespace_private():
    rows = mountinfo_rows()
    if any(any(item.startswith(("shared:", "master:", "propagate_from:")) for item in row["optional"]) for row in rows):
        raise SupervisorFailure("MOUNT_PROPAGATION_NOT_RECURSIVELY_PRIVATE")


def opt_snapshot():
    root = Path("/opt")
    before = root.lstat()
    if not stat.S_ISDIR(before.st_mode) or stat.S_ISLNK(before.st_mode):
        raise SupervisorFailure("OUTER_OPT_ROOT_INVALID")
    children = []
    for entry in sorted(os.scandir(root), key=lambda item: item.name):
        metadata = entry.stat(follow_symlinks=False)
        item = {"name": entry.name, "device": metadata.st_dev, "inode": metadata.st_ino, "uid": metadata.st_uid, "gid": metadata.st_gid, "mode": stat.S_IMODE(metadata.st_mode), "size": metadata.st_size, "mtimeNs": metadata.st_mtime_ns}
        if stat.S_ISLNK(metadata.st_mode):
            item["target"] = os.readlink(entry.path)
        children.append(item)
        if len(children) > 20000:
            raise SupervisorFailure("OUTER_OPT_SNAPSHOT_OVERSIZE")
    mount_rows = tuple(row["raw"] for row in mountinfo_rows() if row["mountpoint"] == "/opt" or row["mountpoint"].startswith("/opt/"))
    return {"identity": {"device": before.st_dev, "inode": before.st_ino, "uid": before.st_uid, "gid": before.st_gid, "mode": stat.S_IMODE(before.st_mode)}, "children": children, "mounts": mount_rows}


def namespace_processes(namespace_number):
    found = []
    unknown = []
    for entry in os.scandir("/proc"):
        if not entry.name.isdigit():
            continue
        pid = int(entry.name)
        try:
            start_identity = process_start_identity(pid)
            identity = namespace_identity(pid, "mnt")
            if process_start_identity(pid) != start_identity:
                raise SupervisorFailure("PROCESS_IDENTITY_CHANGED_DURING_NAMESPACE_SCAN")
        except (FileNotFoundError, ProcessLookupError):
            continue
        except PermissionError as error:
            raise SupervisorFailure("NAMESPACE_PROCESS_IDENTITY_UNREADABLE") from error
        if identity["number"] == namespace_number:
            found.append(pid)
        fd_directory = Path(entry.path) / "fd"
        try:
            descriptors = tuple(os.scandir(fd_directory))
        except (FileNotFoundError, ProcessLookupError):
            continue
        except PermissionError as error:
            raise SupervisorFailure("NAMESPACE_REFERENCE_SCAN_UNREADABLE") from error
        for descriptor in descriptors:
            try:
                link = os.readlink(descriptor.path)
            except (FileNotFoundError, ProcessLookupError):
                continue
            except PermissionError as error:
                raise SupervisorFailure("NAMESPACE_DESCRIPTOR_READ_UNREADABLE") from error
            if link == f"mnt:[{namespace_number}]":
                unknown.append((pid, descriptor.name))
        try:
            if process_start_identity(pid) != start_identity:
                raise SupervisorFailure("PROCESS_IDENTITY_CHANGED_DURING_REFERENCE_SCAN")
        except (FileNotFoundError, ProcessLookupError):
            continue
        except PermissionError as error:
            raise SupervisorFailure("NAMESPACE_PROCESS_IDENTITY_UNREADABLE") from error
    return found, unknown


def namespace_disappeared(namespace_number, deadline=10.0):
    end = time.monotonic() + deadline
    while time.monotonic() < end:
        processes, descriptors = namespace_processes(namespace_number)
        if not processes and not descriptors:
            return True
        time.sleep(0.05)
    return False


def current_host_ids():
    return namespace_identity(os.getpid(), "user"), namespace_identity(os.getpid(), "pid"), namespace_identity(os.getpid(), "mnt")


def make_request(policy_h, config_q):
    if not re.fullmatch(r"[0-9a-f]{64}", policy_h) or not re.fullmatch(r"[0-9a-f]{64}", config_q):
        raise SupervisorFailure("APPLICATION_HQ_INVALID")
    header = bytearray(160)
    header[:8] = b"S8BRQ001"
    struct.pack_into(">H", header, 8, 1)
    header[10] = 1
    header[12:28] = b"run110-valid-hq1"
    header[28:60] = bytes.fromhex(policy_h)
    header[60:92] = bytes.fromhex(config_q)
    header[100:132] = hashlib.sha256(b"").digest()
    return bytes(header)


def app_identity_command(uid, gid, command):
    return [
        "/usr/bin/setpriv", "--reuid", str(uid), "--regid", str(gid),
        "--clear-groups", "--inh-caps=-all", "--ambient-caps=-all",
        "--bounding-set=-all", "--", *command,
    ]


def protected_snapshot():
    roots = (Path(HOSTED_PRIVATE_ROOT), Path("/etc/swooshz/s8-broker-v1.json"), Path(HOSTED_SUDOERS), Path(HOSTED_BROKER), Path(HOSTED_LAUNCHER))
    output = []
    budget = [0, 0]

    def visit(path):
        metadata = path.lstat()
        item = [str(path), metadata.st_dev, metadata.st_ino, metadata.st_uid, metadata.st_gid, stat.S_IMODE(metadata.st_mode), metadata.st_nlink, metadata.st_size, metadata.st_mtime_ns]
        if stat.S_ISLNK(metadata.st_mode):
            item.append(os.readlink(path))
        elif stat.S_ISREG(metadata.st_mode):
            budget[1] += metadata.st_size
            if budget[1] > 128 * 1024 * 1024:
                raise SupervisorFailure("PROTECTED_SNAPSHOT_BYTE_LIMIT")
            item.append(sha256_file(path))
        elif stat.S_ISDIR(metadata.st_mode):
            for child in sorted(path.iterdir(), key=lambda item: item.name):
                budget[0] += 1
                if budget[0] > 20000:
                    raise SupervisorFailure("PROTECTED_SNAPSHOT_ENTRY_LIMIT")
                visit(child)
        else:
            item.append("SPECIAL")
        output.append(tuple(item))

    for root in roots:
        if root.exists() or root.is_symlink():
            visit(root)
        else:
            output.append((str(root), "ABSENT"))
    return tuple(output)


def user_environment(uid, node, corepack, *, workspace, carrier, temp_root, policy_h, config_q):
    account = host_uid_gid(uid, os.getgid() if uid == os.getuid() else pwd.getpwuid(uid).pw_gid)
    node_path = str(Path(toolchain_identity(node)["resolved"]).parent)
    corepack_path = str(Path(toolchain_identity(corepack)["resolved"]).parent)
    return {
        "PATH": f"{corepack_path}:{node_path}:/usr/local/bin:/usr/bin:/bin",
        "HOME": account.pw_dir,
        "USER": account.pw_name,
        "LOGNAME": account.pw_name,
        "PWD": str(workspace),
        "GITHUB_WORKSPACE": str(workspace),
        "COREPACK_ENABLE_AUTO_PIN": "0",
        "S8_APP_CARRIER": str(carrier),
        "S8_APP_WORK": str(Path(carrier) / "work"),
        "S8_APP_SANDBOX": HOSTED_LAUNCHER,
        "S8_APP_PRIVATE_ROOT": HOSTED_PRIVATE_ROOT,
        "S8_APP_SANDBOX_POLICY_SHA256": policy_h,
        "S8_APP_CONFIG_SHA256": config_q,
        "LC_ALL": "C",
    }


def run_sudo_matrix(uid, gid, workspace, temp_root, policy_h, config_q, ledger_path, mount_id):
    root_before = protected_snapshot()
    request = make_request(policy_h, config_q)
    base_env = {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": pwd.getpwuid(uid).pw_dir, "USER": pwd.getpwuid(uid).pw_name, "LOGNAME": pwd.getpwuid(uid).pw_name, "LC_ALL": "C"}

    def run_as_user(argv, *, payload=b"", env=None, label="SUDO_MATRIX_COMMAND"):
        log_path = Path(temp_root) / ".namespace-state" / (label.lower().replace("_", "-") + ".log")
        completed = supervised_command(app_identity_command(uid, gid, argv), cwd=workspace, env=env or base_env, label=label, log_path=log_path, timeout=10, stdin=payload)
        return completed

    positive = run_as_user([HOSTED_LAUNCHER], payload=request, label="SUDO_EXACT_STDIO_POSITIVE")
    if positive.returncode != 0 or len(positive.stdout) < 320 or positive.stdout[:8] != b"S8BRS001" or struct.unpack_from(">H", positive.stdout, 28)[0] == 65:
        raise SupervisorFailure("SUDO_EXACT_STDIO_OR_HQ_ADMISSION_FAILED")
    emit_to_stdout("SUDO_STDIO_PASSWORDLESS=PASS\nSUDO_VALID_HQ_CALLER_ADMISSION=PASS\n")

    sudoers_path = Path(HOSTED_SUDOERS)
    sudoers_before = sudoers_path.lstat()
    if not stat.S_ISREG(sudoers_before.st_mode) or (sudoers_before.st_uid, sudoers_before.st_gid, stat.S_IMODE(sudoers_before.st_mode), sudoers_before.st_nlink) != (0, 0, 0o440, 1):
        raise SupervisorFailure("SUDOERS_POLICY_IDENTITY_INVALID")
    sudoers_identity = (sudoers_before.st_dev, sudoers_before.st_ino, sudoers_before.st_uid, sudoers_before.st_gid, sudoers_before.st_mode, sudoers_before.st_nlink)
    original = sudoers_path.read_bytes()
    if b"NOPASSWD:" not in original or b"stay_setuid" not in original:
        raise SupervisorFailure("SUDOERS_REQUIRED_CONTROLS_MISSING")

    def replace_policy(mutated, label):
        descriptor = os.open(sudoers_path, os.O_WRONLY | os.O_TRUNC | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            opened = os.fstat(descriptor)
            if (opened.st_dev, opened.st_ino, opened.st_uid, opened.st_gid, opened.st_mode, opened.st_nlink) != sudoers_identity:
                raise SupervisorFailure("SUDOERS_POLICY_IDENTITY_CHANGED")
            offset = 0
            while offset < len(mutated):
                offset += os.write(descriptor, mutated[offset:])
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        validation = supervised_command(["/usr/sbin/visudo", "-c", "-f", "/etc/sudoers"], label=label, log_path=Path(temp_root) / ".namespace-state" / (label.lower() + ".log"), timeout=10)
        if validation.returncode != 0:
            raise SupervisorFailure("SUDOERS_MATRIX_FIXTURE_INVALID:" + label)

    try:
        without_nopasswd = original.replace(b"NOPASSWD:", b"PASSWD:", 1)
        replace_policy(without_nopasswd, "SUDOERS_WITHOUT_NOPASSWD_PARSE")
        before = protected_snapshot()
        denied = run_as_user(["/usr/bin/sudo", "-n", "--", HOSTED_BROKER, "--stdio-v1"], payload=request, label="SUDO_NO_NOPASSWD_NEGATIVE")
        if denied.returncode == 0 or protected_snapshot() != before:
            raise SupervisorFailure("SUDO_NO_NOPASSWD_FALSE_GREEN")
        emit_to_stdout("SUDO_NO_NOPASSWD_DENIED=PASS\n")

        replace_policy(original, "SUDOERS_NOPASSWD_RESTORE_PARSE")
        without_stay = original.replace(b"stay_setuid,", b"", 1)
        replace_policy(without_stay, "SUDOERS_WITHOUT_STAY_SETUID_PARSE")
        before = protected_snapshot()
        failed_identity = run_as_user([HOSTED_LAUNCHER], payload=request, label="SUDO_NO_STAY_SETUID_NEGATIVE")
        if failed_identity.returncode != 0 or len(failed_identity.stdout) < 320 or struct.unpack_from(">H", failed_identity.stdout, 28)[0] != 65 or protected_snapshot() != before:
            raise SupervisorFailure("SUDO_NO_STAY_SETUID_CALLER_ADMISSION_FALSE_GREEN")
        emit_to_stdout("SUDO_NO_STAY_SETUID_CALLER_REJECTED=PASS\n")
    finally:
        descriptor = os.open(sudoers_path, os.O_WRONLY | os.O_TRUNC | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            opened = os.fstat(descriptor)
            if (opened.st_dev, opened.st_ino, opened.st_uid, opened.st_gid, opened.st_mode, opened.st_nlink) != sudoers_identity:
                raise SupervisorFailure("SUDOERS_POLICY_IDENTITY_CHANGED_DURING_RESTORE")
            offset = 0
            while offset < len(original):
                offset += os.write(descriptor, original[offset:])
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        os.utime(sudoers_path, ns=(sudoers_before.st_atime_ns, sudoers_before.st_mtime_ns), follow_symlinks=False)
        restored = sudoers_path.lstat()
        if (restored.st_dev, restored.st_ino, restored.st_uid, restored.st_gid, restored.st_mode, restored.st_nlink) != sudoers_identity or sudoers_path.read_bytes() != original:
            raise SupervisorFailure("SUDOERS_POLICY_RESTORE_IDENTITY_INVALID")
        check = supervised_command(["/usr/sbin/visudo", "-c", "-f", "/etc/sudoers"], label="SUDOERS_RESTORE_VALIDATION", log_path=Path(temp_root) / ".namespace-state" / "sudoers-restore.log", timeout=10)
        if check.returncode != 0:
            raise SupervisorFailure("SUDOERS_RESTORE_VALIDATION_FAILED")
    supervised_command(["/usr/bin/mount", "-o", "remount,bind,ro", "/etc/sudoers.d"], label="NAMESPACE_SUDOERS_FINAL_READONLY_FAILED", timeout=10)

    with tempfile.TemporaryDirectory(prefix="s8-sudo-matrix-", dir="/tmp") as matrix_path:
        matrix_root = Path(matrix_path)
        matrix_meta = matrix_root.lstat()
        if not stat.S_ISDIR(matrix_meta.st_mode) or (matrix_meta.st_uid, matrix_meta.st_gid, stat.S_IMODE(matrix_meta.st_mode)) != (0, 0, 0o700):
            raise SupervisorFailure("SUDO_MATRIX_ROOT_IDENTITY_INVALID")
        matrix_identity = (matrix_meta.st_dev, matrix_meta.st_ino)
        os.chmod(matrix_root, 0o755)
        alternate_copy = matrix_root / "copied-broker"
        source_fd = os.open(HOSTED_BROKER, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        destination_fd = None
        try:
            destination_fd = os.open(alternate_copy, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o755)
            source_meta = os.fstat(source_fd)
            if not stat.S_ISREG(source_meta.st_mode) or (source_meta.st_uid, source_meta.st_gid, source_meta.st_nlink, stat.S_IMODE(source_meta.st_mode)) != (0, 0, 1, 0o755):
                raise SupervisorFailure("SUDO_MATRIX_SOURCE_BROKER_IDENTITY_INVALID")
            while True:
                chunk = os.read(source_fd, 1024 * 1024)
                if not chunk:
                    break
                view = memoryview(chunk)
                while view:
                    view = view[os.write(destination_fd, view):]
            os.fchown(destination_fd, 0, 0)
            os.fchmod(destination_fd, 0o755)
            os.fsync(destination_fd)
        finally:
            os.close(source_fd)
            if destination_fd is not None:
                os.close(destination_fd)
        copied_meta = alternate_copy.lstat()
        if not stat.S_ISREG(copied_meta.st_mode) or (copied_meta.st_uid, copied_meta.st_gid, copied_meta.st_nlink, stat.S_IMODE(copied_meta.st_mode)) != (0, 0, 1, 0o755):
            raise SupervisorFailure("SUDO_MATRIX_COPY_IDENTITY_INVALID")
        alternate_link = matrix_root / "linked-broker"
        alternate_link.symlink_to(HOSTED_BROKER)
        denied_cases = [
            ("RECOVERY", ["/usr/bin/sudo", "-n", "--", HOSTED_BROKER, "--recover-v1"], uid, gid, base_env),
            ("EXTRA_ARGUMENT", ["/usr/bin/sudo", "-n", "--", HOSTED_BROKER, "--stdio-v1", "extra"], uid, gid, base_env),
            ("EMPTY_ARGUMENT", ["/usr/bin/sudo", "-n", "--", HOSTED_BROKER, "--stdio-v1", ""], uid, gid, base_env),
            ("ALTERNATE_COPY", ["/usr/bin/sudo", "-n", "--", str(alternate_copy), "--stdio-v1"], uid, gid, base_env),
            ("ALTERNATE_SYMLINK", ["/usr/bin/sudo", "-n", "--", str(alternate_link), "--stdio-v1"], uid, gid, base_env),
            ("WRONG_RUNAS", ["/usr/bin/sudo", "-n", "-u", "nobody", "--", HOSTED_BROKER, "--stdio-v1"], uid, gid, base_env),
            ("PRESERVE_ENV", ["/usr/bin/sudo", "-n", "-E", "--", HOSTED_BROKER, "--stdio-v1"], uid, gid, dict(base_env, HOSTILE_S8_ENV="preserve")),
            ("ENV_ASSIGNMENT", ["/usr/bin/sudo", "-n", "HOSTILE_S8_ENV=assignment", "--", HOSTED_BROKER, "--stdio-v1"], uid, gid, base_env),
            ("PYTHON_AUTHORITY", ["/usr/bin/sudo", "-n", "--", "/usr/bin/python3", "-c", "pass"], uid, gid, base_env),
            ("SHELL_AUTHORITY", ["/usr/bin/sudo", "-n", "--", "/bin/sh", "-c", "true"], uid, gid, base_env),
            ("SETPRIV_AUTHORITY", ["/usr/bin/sudo", "-n", "--", "/usr/bin/setpriv", "--version"], uid, gid, base_env),
            ("GENERAL_DIAGNOSTIC", ["/usr/bin/sudo", "-n", "--", "/usr/bin/id", "-u"], uid, gid, base_env),
            ("WRONG_CALLER", ["/usr/bin/sudo", "-n", "--", HOSTED_BROKER, "--stdio-v1"], 65534, 65534, {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": "/nonexistent", "LC_ALL": "C"}),
        ]
        for name, command, caller_uid, caller_gid, env in denied_cases:
            before = protected_snapshot()
            result = supervised_command(app_identity_command(caller_uid, caller_gid, command), cwd=workspace, env=env, label="SUDO_DENY_" + name, log_path=Path(temp_root) / ".namespace-state" / ("deny-" + name.lower() + ".log"), timeout=10, stdin=request)
            after = protected_snapshot()
            if result.returncode == 0 or before != after:
                raise SupervisorFailure("SUDO_DENIAL_OR_SIDE_EFFECT_FALSE_GREEN:" + name)
            emit_to_stdout("SUDO_DENY_" + name + "=PASS\n")
        alternate_copy.unlink()
        alternate_link.unlink()
        os.chmod(matrix_root, 0o700)
        final_matrix_meta = matrix_root.lstat()
        if (final_matrix_meta.st_dev, final_matrix_meta.st_ino, final_matrix_meta.st_uid, final_matrix_meta.st_gid, stat.S_IMODE(final_matrix_meta.st_mode)) != (matrix_identity[0], matrix_identity[1], 0, 0, 0o700):
            raise SupervisorFailure("SUDO_MATRIX_ROOT_CLEANUP_IDENTITY_INVALID")
        if any(matrix_root.iterdir()):
            raise SupervisorFailure("SUDO_MATRIX_ROOT_UNEXPECTED_CONTENT")
        if protected_snapshot() != root_before:
            raise SupervisorFailure("SUDO_DENIED_CASES_CHANGED_PROTECTED_STATE")
        emit_to_stdout("SUDO_MATRIX=PASS\nSUDO_ISOLATED_POLICY_NO_BROAD_GRANT=PASS\nSUDO_DENIED_SIDE_EFFECTS=ZERO\n")
    if Path(matrix_path).exists() or Path(matrix_path).is_symlink():
        raise SupervisorFailure("SUDO_MATRIX_ROOT_REMAINS")


def emit_to_stdout(text):
    if CURRENT_RESULT_FD >= 0:
        emit(CURRENT_RESULT_FD, "output", text=text)
    else:
        data = text.encode("utf-8")
        offset = 0
        while offset < len(data):
            offset += os.write(1, data[offset:])


def observe_application_targets(app_pid, app_start_identity, status_path, cancel_event, expected_uid, expected_gid):
    observed = set()
    failed = False
    while True:
        try:
            if process_start_identity(app_pid) != app_start_identity:
                failed = True
                break
            process_state = Path(f"/proc/{app_pid}/stat").read_text(encoding="ascii").rsplit(")", 1)[1].strip().split()[0]
            if process_state == "Z":
                break
        except (FileNotFoundError, ProcessLookupError):
            break
        except (PermissionError, SupervisorFailure, OSError):
            failed = True
            break
        try:
            os.kill(app_pid, 0)
        except ProcessLookupError:
            break
        for entry in os.scandir("/proc"):
            if not entry.name.isdigit():
                continue
            try:
                pid = int(entry.name)
                start_identity = process_start_identity(pid)
                command = Path(entry.path, "cmdline").read_bytes()
                kind = "writer" if b"/runtime/blender-root/blender\0" in command else "validator" if b"/runtime/validator\0" in command else None
                if kind is None:
                    continue
                variables = [item for item in Path(entry.path, "environ").read_bytes().split(b"\0") if item]
                keys = {item.split(b"=", 1)[0] for item in variables}
                actual_uid, actual_gid = process_uid_gid(pid)
                if (actual_uid != (expected_uid,) * 4 or actual_gid != (expected_gid,) * 4
                        or len(variables) != 1 or keys != {b"PWD"} or variables != [b"PWD=/work"]):
                    failed = True
                if process_start_identity(pid) != start_identity:
                    failed = True
                    continue
                observed.add(kind)
            except (FileNotFoundError, ProcessLookupError, PermissionError):
                failed = True
                continue
        if cancel_event.is_set():
            failed = True
        time.sleep(0.003)
    status_path.write_text("PASS\n" if not failed and observed == {"writer", "validator"} else "FAIL\n", encoding="ascii")
    return not failed and observed == {"writer", "validator"}


def application_proof(workspace, carrier, temp_root, node, corepack, uid, gid, policy_h, config_q, ledger_path, mount_id, cancel_event):
    proof_path = Path(workspace) / APP_PROOF_RELATIVE
    helper_path = Path(workspace) / APP_HELPER_RELATIVE
    proof_bytes = proof_path.read_bytes()
    helper_bytes = helper_path.read_bytes()
    if len(proof_bytes) != APP_PROOF_BYTES or hashlib.sha256(proof_bytes).hexdigest() != APP_PROOF_SHA256 or len(helper_bytes) != APP_HELPER_BYTES or hashlib.sha256(helper_bytes).hexdigest() != APP_HELPER_SHA256:
        raise SupervisorFailure("APPLICATION_HELPER_BYTES_MISMATCH")
    app_proof = Path(temp_root) / "s8-application-boundary-proof.mts"
    descriptor = os.open(app_proof, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        os.write(descriptor, proof_bytes)
        os.fchown(descriptor, uid, gid)
        os.fchmod(descriptor, 0o600)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    root_state = Path(os.environ["S8_ROOT_STATE"])
    stdout_path = root_state / "application-proof.stdout"
    status_path = root_state / "application-target-env.status"
    for path in (stdout_path, status_path):
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        os.fchown(descriptor, 0, 0)
        os.fchmod(descriptor, 0o600)
        os.close(descriptor)
    account = host_uid_gid(uid, gid)
    env = user_environment(uid, node, corepack, workspace=workspace, carrier=carrier, temp_root=temp_root, policy_h=policy_h, config_q=config_q)
    env["COREPACK_HOME"] = str(Path(account.pw_dir) / ".cache/node/corepack")
    application_command = app_identity_command(uid, gid, [toolchain_identity(corepack)["resolved"], "pnpm@12.6.0", "exec", "tsx", str(app_proof)])
    process = launch_owned_to_log(application_command, log_path=stdout_path, owner=f"namespace-holder:{os.getpid()}:application", ledger_path=ledger_path, mount_id=mount_id, cwd=workspace, env=env)
    observer = None
    try:
        require_process_identity(process, uid, gid)
        observer_result = []
        observer = threading.Thread(target=lambda: observer_result.append(observe_application_targets(
            process.pid, process.start_identity, status_path, cancel_event, uid, gid,
        )), daemon=True)
        observer.start()
        status = wait_owned_cancelable(process, cancel_event, 90 * 60)
        observer.join(timeout=5)
        if observer.is_alive() or not observer_result or not observer_result[0] or status != 0:
            raise SupervisorFailure("APPLICATION_BOUNDARY_PROOF_FAILED")
        if status_path.read_text(encoding="ascii") != "PASS\n":
            raise SupervisorFailure("APPLICATION_TARGET_ENVIRONMENT_PROOF_FAILED")
        output = stdout_path.read_text(encoding="utf-8", errors="replace")
        required_application_output = (
            "APPLICATION_GENERATED_WRITER=PASS",
            "APPLICATION_GENERATED_VALIDATOR=PASS",
            "BROKER_PROTOCOL_ADMISSION=PASS",
            "BROKER_POLICY_ADMISSION=PASS",
            "BROKER_ALLOCATION_RECOVERY_REGRESSION=PASS",
            "BROKER_PID1_REGISTRATION=PASS",
            "BROKER_PREEXEC_GATE=PASS",
            "BROKER_PIDFD_TEARDOWN=PASS",
            "BROKER_PID_REUSE_REGRESSION=PASS",
            "BROKER_CLEANUP_RECOVERY=PASS",
            "APPLICATION_SEMANTIC_READBACK=PASS",
            "APPLICATION_EXPLICIT_SETENV_COUNT=0",
            "APPLICATION_UID_GID=65534:65534",
            "APPLICATION_CAP_DROP=ALL",
            "BWRAP_CLEAR_ENV_REQUIRED=PASS",
            "FINAL_RUNTIME_ALLOWLIST_PROOF=PASS",
            "BROAD_RUNTIME_BINDS_ABSENT=YES",
        )
        if any(marker not in output.splitlines() for marker in required_application_output):
            raise SupervisorFailure("APPLICATION_PROOF_OUTPUT_ASSERTION_MISSING")
        if hashlib.sha256((Path(workspace) / APP_PROOF_RELATIVE).read_bytes()).hexdigest() != APP_PROOF_SHA256 or hashlib.sha256((Path(workspace) / APP_HELPER_RELATIVE).read_bytes()).hexdigest() != APP_HELPER_SHA256:
            raise SupervisorFailure("APPLICATION_HELPER_BYTES_CHANGED_DURING_RUN")
        emit_to_stdout(output)
        emit_to_stdout("TARGET_ENV_KEYS=PWD\nPARENT_SECRET_HOSTILE_ENV_LEAKAGE=NO\nPRODUCTION_BOUNDARY_PROOF=PASS\nAPPLICATION_PROOF_MTS_AS_EXACT_HOST_USER=PASS\n")
    finally:
        if process.terminal is None:
            terminate_owned(process)
        if observer is not None:
            observer.join(timeout=5)


def require_not_cancelled(cancel_event, stage):
    if cancel_event.is_set():
        raise Cancelled("HOSTED_NAMESPACE_CANCELLED_" + stage)


def wait_owned_cancelable(owned, cancel_event, timeout):
    end = time.monotonic() + timeout
    cancel_deadline = None
    term_deadline = None
    while owned.process.poll() is None:
        if cancel_event.is_set():
            if cancel_deadline is None:
                cancel_deadline = time.monotonic() + BROKER_TEARDOWN_SECONDS
            elif time.monotonic() >= cancel_deadline and term_deadline is None:
                if not owned.signal(signal.SIGTERM, owned.start_identity):
                    raise SupervisorFailure("OWNED_PROCESS_IDENTITY_MISMATCH")
                term_deadline = time.monotonic() + PROCESS_REAP_SECONDS
            elif term_deadline is not None and time.monotonic() >= term_deadline:
                if not owned.signal(signal.SIGKILL, owned.start_identity):
                    raise SupervisorFailure("OWNED_PROCESS_IDENTITY_MISMATCH")
                break
        if time.monotonic() >= end:
            terminate_owned(owned)
            raise SupervisorFailure("APPLICATION_PROOF_TIMEOUT")
        time.sleep(0.05)
    result = owned.wait(PROCESS_REAP_SECONDS)
    if result is None:
        raise SupervisorFailure("APPLICATION_PROCESS_REAP_TIMEOUT")
    return result


def create_namespace_sudoers(temp_root, ledger_path, mount_id):
    state_dir = Path(temp_root) / ".namespace-state"
    sudo_dir = state_dir / "sudoers.d"
    sudo_dir.mkdir(mode=0o700, exist_ok=True)
    os.chown(state_dir, 0, 0)
    os.chmod(state_dir, 0o700)
    os.chown(sudo_dir, 0, 0)
    os.chmod(sudo_dir, 0o755)
    main = state_dir / "sudoers.main"
    descriptor = os.open(main, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o440)
    os.write(descriptor, b"Defaults env_reset\n@includedir /etc/sudoers.d\n")
    os.fchown(descriptor, 0, 0)
    os.fchmod(descriptor, 0o440)
    os.close(descriptor)
    if not Path("/etc/sudoers").is_file() or Path("/etc/sudoers").is_symlink() or not Path("/etc/sudoers.d").is_dir() or Path("/etc/sudoers.d").is_symlink():
        raise SupervisorFailure("HOST_SUDOERS_MOUNTPOINT_INVALID")
    for source, target in ((main, Path("/etc/sudoers")), (sudo_dir, Path("/etc/sudoers.d"))):
        supervised_command(["/usr/bin/mount", "--bind", str(source), str(target)], label="NAMESPACE_SUDOERS_BIND_FAILED", timeout=10)
        if str(target) == "/etc/sudoers":
            supervised_command(["/usr/bin/mount", "-o", "remount,bind,ro", str(target)], label="NAMESPACE_SUDOERS_READONLY_FAILED", timeout=10)
    rows = mountinfo_rows()
    for target in ("/etc/sudoers", "/etc/sudoers.d"):
        matching = [row for row in rows if row["mountpoint"] == target]
        if len(matching) != 1:
            raise SupervisorFailure("NAMESPACE_SUDOERS_POLICY_MOUNT_INVALID")
        options = matching[0]["raw"].split(" ")[5].split(",")
        if (target == "/etc/sudoers" and "ro" not in options) or (target == "/etc/sudoers.d" and "ro" in options):
            raise SupervisorFailure("NAMESPACE_SUDOERS_POLICY_MOUNT_INVALID")
    emit_to_stdout("APPLICATION_SUDOERS_NAMESPACE_POLICY=ISOLATED\n")


def private_opt_mount(outer_opt, ledger_path, mount_id):
    before = Path("/opt").lstat()
    if not stat.S_ISDIR(before.st_mode) or (before.st_uid, before.st_gid, stat.S_IMODE(before.st_mode)) != (0, 0, 0o755):
        raise SupervisorFailure("OUTER_OPT_MOUNTPOINT_INVALID")
    supervised_command(["/usr/bin/mount", "-t", "tmpfs", "-o", "size=4G,mode=0755,nosuid,nodev", "tmpfs", "/opt"], label="ROUTE_B_OPT_MOUNT_FAILED", timeout=20)
    metadata = Path("/opt").stat()
    rows = [row for row in mountinfo_rows() if row["mountpoint"] == "/opt"]
    if (metadata.st_uid, metadata.st_gid, stat.S_IMODE(metadata.st_mode)) != (0, 0, 0o755) or len(rows) != 1 or rows[0]["fstype"] != "tmpfs" or "rw" not in rows[0]["raw"].split(" ")[5].split(","):
        raise SupervisorFailure("ROUTE_B_OPT_MOUNT_IDENTITY_INVALID")
    if (metadata.st_dev, metadata.st_ino) == (before.st_dev, before.st_ino):
        raise SupervisorFailure("ROUTE_B_OPT_FILESYSTEM_NOT_DISTINCT")
    Path("/opt/blender").mkdir(mode=0o755)
    Path("/opt/swooshz").mkdir(mode=0o755)
    for path in (Path("/opt/blender"), Path("/opt/swooshz")):
        os.chown(path, 0, 0)
        os.chmod(path, 0o755)
    emit_to_stdout("ROUTE_B_INNER_OPT=ROOT_ROOT_0755\nROUTE_B_OPT_FILESYSTEM=DISTINCT_TMPFS\n")


def run_hosted_contract(workspace, carrier, temp_root, uid, gid, ledger_path, mount_id, mode, *, cancel_event=None):
    script = Path(workspace) / "native/s8-sandbox-broker/tests/broker_contract.py"
    command = ["/usr/bin/python3", str(script), "--hosted-" + mode, str(carrier), str(temp_root), str(uid), str(gid)] if mode == "deploy" else ["/usr/bin/python3", str(script), "--hosted-cleanup", str(temp_root), str(uid)]
    env = {"PATH": "/usr/local/bin:/usr/bin:/bin", "GITHUB_WORKSPACE": str(workspace), "S8_PROCESS_LEDGER": str(ledger_path), "S8_ROOT_STATE": str(Path(temp_root) / ".namespace-state"), "LC_ALL": "C"}
    log = Path(temp_root) / ".namespace-state" / f"hosted-{mode}.log"
    completed = supervised_command(command, cwd=workspace, env=env, label="HOSTED_BROKER_" + mode.upper() + "_FAILED", log_path=log, timeout=(90 * 60 if mode == "deploy" else ROOT_CLEANUP_SECONDS), cancel_event=cancel_event)
    output = completed.stdout.decode("utf-8", errors="replace")
    emit_to_stdout(output)
    if completed.returncode != 0:
        raise SupervisorFailure("HOSTED_BROKER_" + mode.upper() + "_FAILED")
    return output


def control_reader(fd, cancel_event, release_event):
    while True:
        try:
            value = os.read(fd, 1)
        except OSError:
            return
        if not value:
            return
        if value == b"C":
            cancel_event.set()
        elif value == b"R":
            release_event.set()


def inner_holder(workspace, carrier, temp_root, uid, gid, node, corepack, control_fd, result_fd, ledger_path, outer_user_ns, outer_pid_ns, mode):
    global CURRENT_RESULT_FD, CURRENT_CANCEL_EVENT
    CURRENT_RESULT_FD = result_fd
    cancel_event = threading.Event()
    CURRENT_CANCEL_EVENT = cancel_event
    os.environ["S8_PROCESS_LEDGER"] = str(ledger_path)
    os.environ["S8_ROOT_STATE"] = str(Path(temp_root) / ".namespace-state")
    os.environ["S8_HOST_UID"] = str(uid)
    release_event = threading.Event()
    control = threading.Thread(target=control_reader, args=(control_fd, cancel_event, release_event), daemon=True)
    control.start()
    process_start_identity(os.getpid())
    user_ns = namespace_identity(os.getpid(), "user")
    pid_ns = namespace_identity(os.getpid(), "pid")
    mount_ns = namespace_identity(os.getpid(), "mnt")
    if mode == "fixture":
        if user_ns["number"] != outer_user_ns or pid_ns["number"] != outer_pid_ns:
            emit(result_fd, "failure", reason="FIXTURE_USER_OR_PID_NAMESPACE_CHANGED")
            return 2
        supervised_command(["/usr/bin/mount", "--make-rprivate", "/"], label="FIXTURE_PRIVATE_PROPAGATION_FAILED", timeout=10)
        mount_namespace_private()
        emit(result_fd, "ready", pid=os.getpid(), mountNamespace=mount_ns["number"], userNamespace=user_ns["number"], pidNamespace=pid_ns["number"])
        emit(result_fd, "barrier", childrenQuiescent=True, holderReaped=False, outerStateRevalidated=False, complete=False)
        os.close(result_fd)
        while not release_event.wait(0.05):
            if cancel_event.is_set():
                return 143
        return 0
    if mode in {"fixture-opt-cancel", "fixture-application-cancel"}:
        if user_ns["number"] != outer_user_ns or pid_ns["number"] != outer_pid_ns:
            emit(result_fd, "failure", reason="FIXTURE_USER_OR_PID_NAMESPACE_CHANGED")
            return 2
        supervised_command(["/usr/bin/mount", "--make-rprivate", "/"], label="FIXTURE_PRIVATE_PROPAGATION_FAILED", timeout=10)
        mount_namespace_private()
        private_opt_mount(None, Path(ledger_path), mount_ns["number"])
        runner = host_uid_gid(uid, gid)
        fixture_log = Path(temp_root) / ".namespace-state" / (mode + ".log")
        fixture_env = {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": runner.pw_dir, "USER": runner.pw_name, "LOGNAME": runner.pw_name, "LC_ALL": "C"}
        fixture_code = "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); print('S8_CANCELLATION_CHILD_READY', flush=True); time.sleep(3600)"
        workload = launch_owned_to_log(
            app_identity_command(uid, gid, ["/usr/bin/python3", "-c", fixture_code]), log_path=fixture_log,
            owner=f"namespace-holder:{os.getpid()}:{mode}-workload",
            ledger_path=ledger_path, mount_id=mount_ns["number"], cwd=workspace, env=fixture_env,
        )
        try:
            require_process_identity(workload, uid, gid)
            ready_deadline = time.monotonic() + 5.0
            while time.monotonic() < ready_deadline:
                if b"S8_CANCELLATION_CHILD_READY\n" in fixture_log.read_bytes():
                    break
                if workload.process.poll() is not None:
                    raise SupervisorFailure("CANCELLATION_FIXTURE_CHILD_EXITED_EARLY")
                time.sleep(0.01)
            else:
                raise SupervisorFailure("CANCELLATION_FIXTURE_CHILD_NOT_READY")
            if workload.signal(signal.SIGTERM, workload.start_identity + ":mismatch") or workload.process.poll() is not None:
                raise SupervisorFailure("CANCELLATION_FIXTURE_IDENTITY_MISMATCH_FALSE_GREEN")
            stage = "OPT_MOUNTED" if mode == "fixture-opt-cancel" else "APPLICATION_RUNNING"
            emit(result_fd, "stage", name=stage, mountNamespace=mount_ns["number"])
            while not cancel_event.wait(0.05):
                if release_event.is_set():
                    raise SupervisorFailure("CANCELLATION_FIXTURE_RELEASED_WITHOUT_CANCEL")
            result = terminate_owned(workload, grace=0.1)
            if result != -signal.SIGKILL or workload.terminal != result:
                raise SupervisorFailure("TERM_RESISTANT_CHILD_TEARDOWN_INVALID")
            emit(result_fd, "stage", name="CANCELLED_CHILD_REAPED", status=result)
            emit(result_fd, "output", text="TERM_RESISTANT_OWNED_CHILD=PASS\nPID_IDENTITY_MISMATCH_REFUSED=PASS\n")
            active = active_namespace_children(mount_ns["number"], exclude={os.getpid(), int(os.environ.get("S8_ROOT_SUPERVISOR_PID", "0"))})
            if active:
                raise SupervisorFailure("CANCELLATION_FIXTURE_CHILDREN_REMAIN")
        finally:
            if workload.terminal is None:
                if workload.process.poll() is None:
                    terminate_owned(workload)
                else:
                    workload.wait(0)
        emit(result_fd, "ready", pid=os.getpid(), mountNamespace=mount_ns["number"], userNamespace=user_ns["number"], pidNamespace=pid_ns["number"])
        emit(result_fd, "barrier", childrenQuiescent=True, holderReaped=False, outerStateRevalidated=False, complete=False)
        os.close(result_fd)
        while not release_event.wait(0.05):
            pass
        return 143

    deployment_attempted = False
    cleanup_passed = False
    primary_error = None
    final_status = 2
    try:
        emit(result_fd, "stage", name="NAMESPACE_READY", mountNamespace=mount_ns["number"], userNamespace=user_ns["number"], pidNamespace=pid_ns["number"])
        if user_ns["number"] != outer_user_ns or pid_ns["number"] != outer_pid_ns:
            raise SupervisorFailure("HOSTED_USER_OR_PID_NAMESPACE_CHANGED")
        supervised_command(["/usr/bin/mount", "--make-rprivate", "/"], label="PRIVATE_PROPAGATION_FAILED", timeout=10)
        mount_namespace_private()
        emit(result_fd, "stage", name="PRIVATE_PROPAGATION")
        require_not_cancelled(cancel_event, "AFTER_PRIVATE_PROPAGATION")
        private_opt_mount(None, ledger_path, mount_ns["number"])
        emit(result_fd, "stage", name="OPT_MOUNTED")
        require_not_cancelled(cancel_event, "AFTER_OPT_MOUNT")
        toolchain = verify_toolchain(node, corepack, workspace=workspace)
        emit_to_stdout("HOSTED_TOOLCHAIN_CONTINUITY=PASS\nHOSTED_TOOLCACHE_PRODUCT_AUTHORITY=ABSENT\n")
        emit(result_fd, "stage", name="TOOLCHAIN_BOUND", node=toolchain["node"]["sha256"], corepack=toolchain["corepack"]["sha256"])
        require_not_cancelled(cancel_event, "AFTER_TOOLCHAIN")
        create_namespace_sudoers(temp_root, ledger_path, mount_ns["number"])
        require_not_cancelled(cancel_event, "BEFORE_BROKER_DEPLOYMENT")
        deployment_attempted = True
        emit(result_fd, "stage", name="BROKER_DEPLOYMENT_ATTEMPTED")
        deployment_output = run_hosted_contract(workspace, carrier, temp_root, uid, gid, ledger_path, mount_ns["number"], "deploy", cancel_event=cancel_event)
        policy_h = parse_one(deployment_output, "HOSTED_POLICY_H")
        config_q = parse_one(deployment_output, "HOSTED_CONFIG_Q")
        emit(result_fd, "stage", name="DEPLOYED", policyH=policy_h, configQ=config_q)
        run_sudo_matrix(uid, gid, workspace, temp_root, policy_h, config_q, ledger_path, mount_ns["number"])
        emit(result_fd, "stage", name="APPLICATION_RUNNING")
        application_proof(workspace, carrier, temp_root, node, corepack, uid, gid, policy_h, config_q, ledger_path, mount_ns["number"], cancel_event)
    except Exception as error:
        primary_error = error
        emit(result_fd, "failure", reason=safe_failure(error))
    finally:
        if not deployment_attempted:
            cleanup_passed = True
        if deployment_attempted:
            try:
                supervisor_pid = int(os.environ.get("S8_ROOT_SUPERVISOR_PID", "0"))
                active_before_recovery = active_namespace_children(mount_ns["number"], exclude={os.getpid(), supervisor_pid})
                if active_before_recovery:
                    raise SupervisorFailure("UNKNOWN_NAMESPACE_PROCESS_REMAINS_BEFORE_RECOVERY")
                emit(result_fd, "stage", name="RECOVERY_CLEANUP")
                supervised_command(["/usr/bin/mount", "-o", "remount,bind,rw", "/etc/sudoers.d"], label="NAMESPACE_SUDOERS_RECOVERY_WRITABLE_FAILED", timeout=10, cancel_event=threading.Event())
                run_hosted_contract(workspace, carrier, temp_root, uid, gid, ledger_path, mount_ns["number"], "cleanup", cancel_event=threading.Event())
                cleanup_passed = True
            except Exception as error:
                emit(result_fd, "failure", reason="HOSTED_RECOVERY_CLEANUP_FAILED:" + safe_failure(error))
        try:
            supervisor_pid = int(os.environ.get("S8_ROOT_SUPERVISOR_PID", "0"))
            active = active_namespace_children(mount_ns["number"], exclude={os.getpid(), supervisor_pid})
            if active:
                raise SupervisorFailure("UNKNOWN_NAMESPACE_PROCESS_REMAINS")
            emit(result_fd, "deploymentCleanup", attempted=deployment_attempted, clean=cleanup_passed)
            emit(result_fd, "stage", name="CHILDREN_QUIESCENT", childrenQuiescent=True, cleanup=cleanup_passed)
            emit(result_fd, "barrier", childrenQuiescent=True, holderReaped=False, outerStateRevalidated=False, complete=False)
            os.close(result_fd)
            final_status = 1 if primary_error is not None or not cleanup_passed else 0
        except Exception as error:
            emit(result_fd, "failure", reason="CHILD_QUIESCENCE_FAILED:" + safe_failure(error))
            final_status = 2
    if final_status != 2:
        while not release_event.wait(0.05):
            if cancel_event.is_set() and primary_error is None:
                primary_error = Cancelled("HOSTED_NAMESPACE_CANCELLED")
        if primary_error is not None or not cleanup_passed:
            final_status = 1
    return final_status


def parse_one(output, key):
    values = [line.split("=", 1)[1] for line in output.splitlines() if line.startswith(key + "=")]
    if len(values) != 1:
        raise SupervisorFailure("HOSTED_DEPLOYMENT_DIGEST_MISSING:" + key)
    return values[0]


def safe_failure(error):
    value = re.sub(r"[^A-Z0-9_.:-]+", "_", str(error).upper())[:200]
    return value or type(error).__name__.upper()


def active_namespace_children(namespace_number, exclude=()):
    processes, descriptors = namespace_processes(namespace_number)
    excluded = set(exclude)
    return [pid for pid in processes if pid not in excluded] + [f"fd:{pid}:{fd}" for pid, fd in descriptors if pid not in excluded]


def make_pipe():
    return os.pipe2(os.O_CLOEXEC)


def read_events_and_eof(fd, deadline, on_event, loop_check=None):
    buffer = bytearray()
    end = time.monotonic() + deadline
    while True:
        if loop_check is not None:
            loop_check()
        remaining = end - time.monotonic()
        if remaining <= 0:
            raise SupervisorFailure("NAMESPACE_HOLDER_RESULT_TIMEOUT")
        readable, _, _ = select.select([fd], [], [], min(0.25, remaining))
        if not readable:
            continue
        block = os.read(fd, 65536)
        if not block:
            if buffer:
                raise SupervisorFailure("NAMESPACE_HOLDER_RESULT_TRUNCATED")
            return
        buffer.extend(block)
        while b"\n" in buffer:
            line, _, rest = buffer.partition(b"\n")
            buffer[:] = rest
            try:
                event = json.loads(line.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                raise SupervisorFailure("NAMESPACE_HOLDER_EVENT_INVALID") from error
            on_event(event)


def drain_until_eof(fd, deadline):
    end = time.monotonic() + deadline
    while True:
        remaining = end - time.monotonic()
        if remaining <= 0:
            raise SupervisorFailure("NAMESPACE_HOLDER_DRAIN_TIMEOUT")
        readable, _, _ = select.select([fd], [], [], min(0.25, remaining))
        if readable and not os.read(fd, 65536):
            return


def launch_holder(mode, *, workspace, carrier, temp_root, uid, gid, node, corepack, ledger_path, outer_ids):
    control_read, control_write = make_pipe()
    result_read, result_write = make_pipe()
    args = [
        "/usr/bin/unshare", "--mount", "--", sys.executable, str(Path(__file__).resolve()),
        "--holder", "--mode", mode, "--workspace", str(workspace), "--carrier", str(carrier),
        "--temp-root", str(temp_root), "--uid", str(uid), "--gid", str(gid), "--node", str(node),
        "--corepack", str(corepack), "--control-fd", str(control_read), "--result-fd", str(result_write),
        "--ledger", str(ledger_path), "--outer-user-ns", str(outer_ids[0]["number"]),
        "--outer-pid-ns", str(outer_ids[1]["number"]), "--supervisor-pid", str(os.getpid()),
    ]
    minimal_env = {"PATH": "/usr/local/bin:/usr/bin:/bin", "LC_ALL": "C", "PYTHONUTF8": "1", "PYTHONUNBUFFERED": "1"}
    log = open(Path(temp_root) / ".namespace-state" / ("holder-" + mode + ".log"), "wb", buffering=0)
    owned = None
    try:
        owned = launch_owned(args, owner=f"root-supervisor:{os.getpid()}:{mode}-holder", ledger_path=ledger_path, cwd=workspace, env=minimal_env, stdout=log, pass_fds=(control_read, result_write))
        os.close(control_read)
        control_read = None
        os.close(result_write)
        result_write = None
        os.set_inheritable(control_write, False)
        return owned, control_write, result_read, log
    except Exception:
        if owned is not None and owned.terminal is None:
            terminate_owned(owned)
        for descriptor in (control_read, result_write, control_write, result_read):
            if descriptor is not None:
                try:
                    os.close(descriptor)
                except OSError:
                    pass
        log.close()
        raise


def holder_events(fd, timeout, event_list, *, cancel_event=None, cancel_callback=None):
    def collect(event):
        event_list.append(event)
        if event.get("kind") == "stage":
            emit_to_stdout("NAMESPACE_STAGE=" + event.get("name", "UNKNOWN") + "\n")
        elif event.get("kind") == "failure":
            emit_to_stdout("NAMESPACE_FAILURE=" + event.get("reason", "UNKNOWN") + "\n")
        elif event.get("kind") == "output":
            emit_to_stdout(event.get("text", ""))

    def check_cancel():
        if cancel_event is not None and cancel_event.is_set() and cancel_callback is not None:
            cancel_callback()

    read_events_and_eof(fd, timeout, collect, loop_check=check_cancel)


def validate_process_ledger(path):
    rows = [json.loads(line) for line in Path(path).read_text(encoding="ascii").splitlines()]
    starts = {}
    terminals = set()
    for row in rows:
        if row.get("event") == "STARTED":
            key = (row.get("pid"), row.get("startIdentity"))
            if key in starts or row.get("pidfd") != "OPEN" or not isinstance(row.get("owner"), str) or not isinstance(row.get("mountNamespace"), int):
                raise SupervisorFailure("PROCESS_LEDGER_START_INVALID")
            starts[key] = row
        elif row.get("event") == "TERMINAL":
            key = (row.get("pid"), row.get("startIdentity"))
            if key not in starts or key in terminals or row.get("pidfd") != "CLOSED_AFTER_WAIT" or not isinstance(row.get("waitResult"), dict):
                raise SupervisorFailure("PROCESS_LEDGER_TERMINAL_INVALID")
            terminals.add(key)
        else:
            raise SupervisorFailure("PROCESS_LEDGER_EVENT_INVALID")
    if set(starts) != terminals:
        raise SupervisorFailure("PROCESS_LEDGER_HAS_UNREAPED_PROCESS")
    return rows


def run_fixture(kind, *, workspace, temp_root, ledger_path, outer_ids, uid, gid, retained_reference=False):
    modes = {
        "leaked-holder": ("fixture", None),
        "positive-release": ("fixture", None),
        "cancel-opt": ("fixture-opt-cancel", "OPT_MOUNTED"),
        "cancel-application": ("fixture-application-cancel", "APPLICATION_RUNNING"),
    }
    if kind not in modes:
        raise SupervisorFailure("LIFECYCLE_FIXTURE_KIND_INVALID")
    mode, cancel_stage = modes[kind]
    owned, control_write, result_read, log = launch_holder(
        mode, workspace=workspace, carrier="/", temp_root=temp_root, uid=uid, gid=gid,
        node="/usr/bin/python3", corepack="/usr/bin/python3", ledger_path=ledger_path, outer_ids=outer_ids,
    )
    holder_nsfd = None
    namespace_number = None
    events = []
    control_closed = False

    def collect(event):
        events.append(event)
        if cancel_stage is not None and event.get("kind") == "stage" and event.get("name") == cancel_stage:
            os.write(control_write, b"C")

    try:
        read_events_and_eof(result_read, 20, collect)
        ready = [event for event in events if event.get("kind") == "ready"]
        barriers = [event for event in events if event.get("kind") == "barrier"]
        if len(ready) != 1 or len(barriers) != 1 or barriers[0] != {"kind": "barrier", "childrenQuiescent": True, "holderReaped": False, "outerStateRevalidated": False, "complete": False}:
            raise SupervisorFailure("FIXTURE_HOLDER_BARRIER_INVALID")
        if ready[0].get("userNamespace") != outer_ids[0]["number"] or ready[0].get("pidNamespace") != outer_ids[1]["number"] or ready[0].get("mountNamespace") == outer_ids[2]["number"]:
            raise SupervisorFailure("FIXTURE_NAMESPACE_IDENTITY_INVALID")
        namespace_number = ready[0]["mountNamespace"]
        holder_nsfd = os.open(f"/proc/{owned.pid}/ns/mnt", os.O_RDONLY | os.O_CLOEXEC)
        if owned.process.poll() is not None:
            raise SupervisorFailure("FIXTURE_HOLDER_REAPED_BEFORE_RELEASE")

        if kind == "leaked-holder":
            time.sleep(LEAK_HOLDER_DEADLINE_SECONDS)
            if owned.process.poll() is not None:
                raise SupervisorFailure("LEAKED_HOLDER_DEADLINE_FALSE_GREEN")
            if not owned.signal(signal.SIGTERM, owned.start_identity):
                raise SupervisorFailure("LEAKED_HOLDER_IDENTITY_BOUND_TERM_FAILED")
            if owned.wait(PROCESS_REAP_SECONDS) is None:
                terminate_owned(owned)
            os.close(control_write)
            control_closed = True
            emit_to_stdout("LEAKED_HOLDER_DEADLINE_RESULT=FAILED_HOLDER_RELEASE_TIMEOUT\nLEAKED_HOLDER_REGRESSION=PASS\n")
        else:
            if cancel_stage is not None:
                stages = [event.get("name") for event in events if event.get("kind") == "stage"]
                if stages.count(cancel_stage) != 1 or "CANCELLED_CHILD_REAPED" not in stages:
                    raise SupervisorFailure("CANCELLATION_FIXTURE_STAGE_MISSING")
                output = "".join(event.get("text", "") for event in events if event.get("kind") == "output")
                if "TERM_RESISTANT_OWNED_CHILD=PASS" not in output or "PID_IDENTITY_MISMATCH_REFUSED=PASS" not in output:
                    raise SupervisorFailure("CANCELLATION_FIXTURE_PROCESS_CONTROLS_MISSING")
            os.write(control_write, b"R")
            os.close(control_write)
            control_closed = True
            expected_status = 143 if cancel_stage is not None else 0
            if owned.wait(PROCESS_REAP_SECONDS) != expected_status:
                raise SupervisorFailure("FIXTURE_HOLDER_RELEASE_STATUS_INVALID")
            if retained_reference and namespace_disappeared(namespace_number, 0.1):
                raise SupervisorFailure("RETAINED_NAMESPACE_DESCRIPTOR_NOT_DETECTED")

        if holder_nsfd is not None:
            os.close(holder_nsfd)
            holder_nsfd = None
        if not namespace_disappeared(namespace_number, NAMESPACE_VERIFY_SECONDS):
            raise SupervisorFailure("FIXTURE_NAMESPACE_REFERENCE_REMAINS")
        if kind == "positive-release":
            emit_to_stdout("POSITIVE_HOLDER_RELEASE_REAP=PASS\nNAMESPACE_REFERENCE_CLOSURE=PASS\n")
        elif kind == "cancel-opt":
            emit_to_stdout("CANCELLATION_AFTER_OPT_MOUNT=PASS\n")
        elif kind == "cancel-application":
            emit_to_stdout("CANCELLATION_DURING_APPLICATION=PASS\n")
    except Exception:
        if owned.process.poll() is None:
            try:
                os.write(control_write, b"CR")
            except OSError:
                pass
            try:
                drain_until_eof(result_read, BROKER_TEARDOWN_SECONDS + ROOT_CLEANUP_SECONDS)
            except SupervisorFailure:
                pass
            if owned.process.poll() is None:
                try:
                    terminate_owned(owned)
                except SupervisorFailure:
                    pass
        if owned.terminal is None and owned.process.poll() is not None:
            owned.wait(0)
        if holder_nsfd is not None:
            os.close(holder_nsfd)
            holder_nsfd = None
        if namespace_number is not None and not namespace_disappeared(namespace_number, NAMESPACE_VERIFY_SECONDS):
            raise SupervisorFailure("FIXTURE_NAMESPACE_REFERENCE_REMAINS_AFTER_FAILURE")
        raise
    finally:
        if not control_closed:
            try:
                os.close(control_write)
            except OSError:
                pass
        try:
            os.close(result_read)
        except OSError:
            pass
        log.close()


def run_owned_process_regressions(temp_root, ledger_path):
    fixture_code = "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); print('S8_IDENTITY_FIXTURE_READY', flush=True); time.sleep(3600)"
    output_path = Path(temp_root) / ".namespace-state" / "identity-term-child.log"
    child = launch_owned_to_log(
        ["/usr/bin/python3", "-c", fixture_code], log_path=output_path,
        owner=f"root-supervisor:{os.getpid()}:termination-regression",
        ledger_path=ledger_path, mount_id=namespace_identity(os.getpid(), "mnt")["number"],
        env={"PATH": "/usr/local/bin:/usr/bin:/bin", "LC_ALL": "C"},
    )
    try:
        ready_deadline = time.monotonic() + 5.0
        while time.monotonic() < ready_deadline:
            if b"S8_IDENTITY_FIXTURE_READY\n" in output_path.read_bytes():
                break
            if child.process.poll() is not None:
                raise SupervisorFailure("PID_IDENTITY_FIXTURE_CHILD_EXITED_EARLY")
            time.sleep(0.01)
        else:
            raise SupervisorFailure("PID_IDENTITY_FIXTURE_CHILD_NOT_READY")
        if child.signal(signal.SIGTERM, child.start_identity + ":mismatch") or child.process.poll() is not None:
            raise SupervisorFailure("PID_IDENTITY_MISMATCH_FALSE_GREEN")
        result = terminate_owned(child, grace=0.1)
        if result != -signal.SIGKILL or child.terminal != result:
            raise SupervisorFailure("TERM_RESISTANT_OWNED_CHILD_REGRESSION_FAILED")
        emit_to_stdout("PID_IDENTITY_MISMATCH_REFUSED=PASS\nTERM_RESISTANT_OWNED_CHILD=PASS\nPIDFD_TERMINAL_REAP=PASS\n")
    finally:
        if child.terminal is None:
            if child.process.poll() is None:
                terminate_owned(child)
            else:
                child.wait(0)


def run_namespace_regressions(workspace, temp_root, ledger_path, outer_ids, uid, gid):
    run_owned_process_regressions(temp_root, ledger_path)
    run_fixture("leaked-holder", workspace=workspace, temp_root=temp_root, ledger_path=ledger_path, outer_ids=outer_ids, uid=uid, gid=gid)
    run_fixture("positive-release", workspace=workspace, temp_root=temp_root, ledger_path=ledger_path, outer_ids=outer_ids, uid=uid, gid=gid, retained_reference=True)
    run_fixture("cancel-opt", workspace=workspace, temp_root=temp_root, ledger_path=ledger_path, outer_ids=outer_ids, uid=uid, gid=gid)
    run_fixture("cancel-application", workspace=workspace, temp_root=temp_root, ledger_path=ledger_path, outer_ids=outer_ids, uid=uid, gid=gid)
    emit_to_stdout("NAMESPACE_HOLDER_LIFECYCLE_REGRESSIONS=PASS\nNAMESPACE_CANCELLATION_REGRESSIONS=PASS\n")


def prepare_state(temp_root):
    state = Path(temp_root) / ".namespace-state"
    state.mkdir(mode=0o700)
    os.chown(state, 0, 0)
    os.chmod(state, 0o700)
    ledger = state / "process-ledger.jsonl"
    descriptor = os.open(ledger, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    os.fchown(descriptor, 0, 0)
    os.fchmod(descriptor, 0o600)
    os.close(descriptor)
    return state, ledger


def root_supervise(args):
    if os.geteuid() != 0 or os.getuid() != 0:
        raise SupervisorFailure("OUTER_ROOT_SUPERVISOR_REQUIRED")
    if not callable(getattr(os, "pidfd_open", None)) or not callable(getattr(signal, "pidfd_send_signal", None)):
        raise SupervisorFailure("PIDFD_UNAVAILABLE")
    probe_pidfd = os.pidfd_open(os.getpid(), 0)
    os.close(probe_pidfd)
    workspace = Path(args.workspace).resolve(strict=True)
    if workspace != Path(__file__).resolve().parents[3]:
        raise SupervisorFailure("HOSTED_WORKSPACE_IDENTITY_INVALID")
    carrier = Path(args.carrier)
    if not re.fullmatch(r"/s8-ci-carrier-[0-9]+\.[0-9]+", str(carrier)):
        raise SupervisorFailure("HOSTED_CARRIER_PATH_INVALID")
    temp_root = Path(args.temp_root)
    temp_meta = temp_root.lstat()
    if not stat.S_ISDIR(temp_meta.st_mode) or stat.S_ISLNK(temp_meta.st_mode) or (temp_meta.st_uid, temp_meta.st_gid, stat.S_IMODE(temp_meta.st_mode)) != (args.uid, args.gid, 0o700):
        raise SupervisorFailure("HOSTED_TEMP_ROOT_IDENTITY_INVALID")
    account = host_uid_gid(args.uid, args.gid)
    outer_ids = current_host_ids()
    outer_opt = opt_snapshot()
    ROOT_CANCEL_EVENT.clear()
    previous_handlers = {sig: signal.signal(sig, request_root_cancel) for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP)}
    state = None
    ledger = None
    holder = None
    regressions_passed = False
    control_write = None
    result_read = None
    log = None
    namespace_fd = None
    holder_namespace = None
    events = []
    cancel_sent = False
    route_b_cleanup_reported = False
    operation_error = None
    cleanup_error = None

    def cancel_holder():
        nonlocal cancel_sent
        if not cancel_sent and control_write is not None:
            os.write(control_write, b"C")
            cancel_sent = True

    try:
        state, ledger = prepare_state(temp_root)
        emit_to_stdout("NAMESPACE_SUPERVISOR=ROOT_ORIGINAL_MOUNT_NAMESPACE\nNAMESPACE_USER_PID_UNCHANGED=REQUIRED\n")
        run_namespace_regressions(workspace, temp_root, ledger, outer_ids, args.uid, args.gid)
        regressions_passed = True
        if ROOT_CANCEL_EVENT.is_set():
            raise Cancelled("HOSTED_NAMESPACE_CANCELLED_DURING_REGRESSIONS")
        holder, control_write, result_read, log = launch_holder(
            "production", workspace=workspace, carrier=carrier, temp_root=temp_root,
            uid=args.uid, gid=args.gid, node=args.node, corepack=args.corepack,
            ledger_path=ledger, outer_ids=outer_ids,
        )
        holder_namespace = holder.mount_id
        holder_events(result_read, 90 * 60, events, cancel_event=ROOT_CANCEL_EVENT, cancel_callback=cancel_holder)
        ready = [event for event in events if event.get("kind") == "stage" and event.get("name") == "NAMESPACE_READY"]
        barriers = [event for event in events if event.get("kind") == "barrier"]
        if len(ready) != 1 or len(barriers) != 1 or barriers[0] != {"kind": "barrier", "childrenQuiescent": True, "holderReaped": False, "outerStateRevalidated": False, "complete": False}:
            raise SupervisorFailure("NAMESPACE_HOLDER_BARRIER_INVALID")
        if ready[0].get("mountNamespace") != holder_namespace:
            raise SupervisorFailure("NAMESPACE_HOLDER_IDENTITY_CHANGED")
        actual = namespace_identity(holder.pid, "mnt")
        if actual["number"] != holder_namespace:
            raise SupervisorFailure("NAMESPACE_HOLDER_IDENTITY_CHANGED")
        namespace_fd = os.open(f"/proc/{holder.pid}/ns/mnt", os.O_RDONLY | os.O_CLOEXEC)
        if holder.process.poll() is not None:
            raise SupervisorFailure("NAMESPACE_HOLDER_REAPED_BEFORE_RELEASE")
        unresolved = active_namespace_children(holder_namespace, exclude={holder.pid})
        if unresolved:
            raise SupervisorFailure("NAMESPACE_CHILDREN_NOT_QUIESCENT")
        time.sleep(0.1)
        if holder.process.poll() is not None:
            raise SupervisorFailure("NAMESPACE_HOLDER_LIVENESS_FALSE_GREEN")
        emit_to_stdout("CHILDREN_QUIESCENT=YES\nNAMESPACE_HOLDER_REAPED=NO\nOUTER_STATE_REVALIDATED=NOT_STARTED\nCOMPLETE=NO\n")
        if ROOT_CANCEL_EVENT.is_set():
            cancel_holder()
        os.write(control_write, b"R")
        os.close(control_write)
        control_write = None
        wait_result = holder.wait(PROCESS_REAP_SECONDS)
        if wait_result is None:
            terminate_owned(holder)
            raise SupervisorFailure("NAMESPACE_HOLDER_REAP_TIMEOUT")
        os.close(namespace_fd)
        namespace_fd = None
        if not namespace_disappeared(holder_namespace, NAMESPACE_VERIFY_SECONDS):
            raise SupervisorFailure("NAMESPACE_REFERENCE_REMAINS")
        emit_to_stdout("NAMESPACE_HOLDER_REAPED=YES\nNAMESPACE_DISAPPEARED=YES\n")
        if current_host_ids() != outer_ids or opt_snapshot() != outer_opt:
            raise SupervisorFailure("OUTER_NAMESPACE_OR_OPT_STATE_CHANGED")
        rows = validate_process_ledger(ledger)
        emit_to_stdout(f"HARNESS_PROCESS_RECORDS={len(rows)}\nOUTER_STATE_REVALIDATED=PASS\nROUTE_B_OUTER_OPT_UNCHANGED=YES\n")
        cleanup_events = [event for event in events if event.get("kind") == "deploymentCleanup"]
        if len(cleanup_events) != 1 or type(cleanup_events[0].get("attempted")) is not bool or type(cleanup_events[0].get("clean")) is not bool:
            raise SupervisorFailure("BROKER_DEPLOYMENT_CLEANUP_WITNESS_INVALID")
        if not cleanup_events[0]["clean"]:
            emit_to_stdout("ROUTE_B_BROKER_CLEANUP=FAIL\nROUTE_B_PRODUCTION_DEPLOYMENT_ABSENT=NO\n")
            route_b_cleanup_reported = True
            raise SupervisorFailure("BROKER_DEPLOYMENT_CLEANUP_UNPROVEN")
        if cleanup_events[0]["attempted"]:
            emit_to_stdout("ROUTE_B_BROKER_CLEANUP=PASS\nROUTE_B_PRODUCTION_DEPLOYMENT_ABSENT=YES\n")
        else:
            emit_to_stdout("ROUTE_B_BROKER_CLEANUP=PASS_NOT_ATTEMPTED\nROUTE_B_PRODUCTION_DEPLOYMENT_ABSENT=YES\n")
        route_b_cleanup_reported = True
        if wait_result != 0:
            if ROOT_CANCEL_EVENT.is_set():
                raise Cancelled("HOSTED_NAMESPACE_CANCELLED_AFTER_CLEANUP")
            raise SupervisorFailure("NAMESPACE_HOLDER_RESULT_NONZERO")
        if ROOT_CANCEL_EVENT.is_set():
            raise Cancelled("HOSTED_NAMESPACE_CANCELLED_AFTER_BARRIER")
        emit_to_stdout("SUPERVISOR_CLEANUP=PASS\n")
    except Exception as caught:
        operation_error = caught
    finally:
        if holder is not None and holder.process.poll() is None:
            try:
                cancel_holder()
                if result_read is not None:
                    drain_until_eof(result_read, BROKER_TEARDOWN_SECONDS + PROCESS_REAP_SECONDS + ROOT_CLEANUP_SECONDS + NAMESPACE_VERIFY_SECONDS)
                if control_write is not None:
                    os.write(control_write, b"R")
                    os.close(control_write)
                    control_write = None
                if holder.wait(BROKER_TEARDOWN_SECONDS + PROCESS_REAP_SECONDS + ROOT_CLEANUP_SECONDS) is None:
                    terminate_owned(holder)
            except Exception as error:
                cleanup_error = error
                if holder.process.poll() is None:
                    try:
                        terminate_owned(holder)
                    except Exception as terminate_error:
                        cleanup_error = SupervisorFailure("NAMESPACE_HOLDER_TEARDOWN_FAILED:" + safe_failure(terminate_error))
        if holder is not None and holder.terminal is None and holder.process.poll() is not None:
            try:
                holder.wait(0)
            except Exception as error:
                cleanup_error = cleanup_error or error
        if namespace_fd is not None:
            os.close(namespace_fd)
            namespace_fd = None
        if control_write is not None:
            try:
                os.close(control_write)
            except OSError:
                pass
        if result_read is not None:
            try:
                os.close(result_read)
            except OSError:
                pass
        if log is not None:
            log.close()
        try:
            if holder is not None and holder.terminal is None:
                raise SupervisorFailure("NAMESPACE_HOLDER_TERMINAL_WITNESS_MISSING")
            if holder_namespace is not None and not namespace_disappeared(holder_namespace, NAMESPACE_VERIFY_SECONDS):
                raise SupervisorFailure("NAMESPACE_REFERENCE_REMAINS_AFTER_TEARDOWN")
            if current_host_ids() != outer_ids or opt_snapshot() != outer_opt:
                raise SupervisorFailure("OUTER_NAMESPACE_OR_OPT_STATE_CHANGED_DURING_TEARDOWN")
            if ledger is not None:
                rows = validate_process_ledger(ledger)
                emit_to_stdout(f"HARNESS_PROCESS_RECORDS={len(rows)}\n")
            if holder is None:
                if not regressions_passed:
                    raise SupervisorFailure("NAMESPACE_REGRESSION_CLEANUP_UNPROVEN")
                if not route_b_cleanup_reported:
                    emit_to_stdout("ROUTE_B_BROKER_CLEANUP=PASS_NOT_ATTEMPTED\nROUTE_B_PRODUCTION_DEPLOYMENT_ABSENT=YES\n")
                    route_b_cleanup_reported = True
            else:
                cleanup_events = [event for event in events if event.get("kind") == "deploymentCleanup"]
                if len(cleanup_events) != 1 or type(cleanup_events[0].get("attempted")) is not bool or type(cleanup_events[0].get("clean")) is not bool or not cleanup_events[0]["clean"]:
                    raise SupervisorFailure("BROKER_DEPLOYMENT_CLEANUP_UNPROVEN")
                if not route_b_cleanup_reported:
                    marker = "PASS" if cleanup_events[0]["attempted"] else "PASS_NOT_ATTEMPTED"
                    emit_to_stdout("ROUTE_B_BROKER_CLEANUP=" + marker + "\nROUTE_B_PRODUCTION_DEPLOYMENT_ABSENT=YES\n")
                    route_b_cleanup_reported = True
            if state is not None and state.exists():
                remove_supervisor_state(state, ledger)
        except Exception as error:
            cleanup_error = cleanup_error or error
        for sig, handler in previous_handlers.items():
            signal.signal(sig, handler)
    if cleanup_error is not None:
        print("NAMESPACE_SUPERVISOR_STATE_CLEANUP=DEFERRED_UNRESOLVED", file=sys.stderr)
        if operation_error is not None:
            raise SupervisorFailure("SUPERVISOR_TEARDOWN_FAILED:" + safe_failure(cleanup_error)) from operation_error
        raise cleanup_error
    if operation_error is not None:
        raise operation_error


def remove_root_owned_state_entry(path, root_device, mountpoints):
    metadata = path.lstat()
    if metadata.st_dev != root_device or metadata.st_uid != 0 or metadata.st_gid != 0:
        raise SupervisorFailure("NAMESPACE_STATE_ENTRY_IDENTITY_INVALID")
    if stat.S_ISDIR(metadata.st_mode):
        if str(path) in mountpoints:
            raise SupervisorFailure("NAMESPACE_STATE_MOUNT_REFUSED")
        for child in sorted(path.iterdir(), key=lambda item: item.name):
            remove_root_owned_state_entry(child, root_device, mountpoints)
        path.rmdir()
        return
    if stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
        if metadata.st_nlink != 1:
            raise SupervisorFailure("NAMESPACE_STATE_LINK_COUNT_INVALID")
        path.unlink()
        return
    raise SupervisorFailure("NAMESPACE_STATE_SPECIAL_FILE_REFUSED")


def remove_supervisor_state(state, ledger):
    metadata = state.lstat()
    if not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != 0 or metadata.st_gid != 0 or stat.S_IMODE(metadata.st_mode) != 0o700:
        raise SupervisorFailure("NAMESPACE_STATE_CLEANUP_IDENTITY_INVALID")
    ledger.resolve(strict=True).relative_to(state.resolve(strict=True))
    validate_process_ledger(ledger)
    mountpoints = {row["mountpoint"] for row in mountinfo_rows()}
    for path in sorted(state.iterdir(), key=lambda item: item.name):
        remove_root_owned_state_entry(path, metadata.st_dev, mountpoints)
    state.rmdir()
    emit_to_stdout("NAMESPACE_SUPERVISOR_STATE_CLEANUP=PASS\n")


def holder_entry(args):
    control_fd = args.control_fd
    result_fd = args.result_fd
    os.environ["S8_ROOT_SUPERVISOR_PID"] = str(args.supervisor_pid)
    # This process entered only the mount namespace; user and PID namespaces
    # are checked against identities received from the root supervisor.
    return inner_holder(Path(args.workspace), Path(args.carrier), Path(args.temp_root), args.uid, args.gid, args.node, args.corepack, control_fd, result_fd, Path(args.ledger), args.outer_user_ns, args.outer_pid_ns, args.mode)


def validate_workflow_semantic_readback(readback, payload):
    if readback.get("schemaVersion") != "s8-ufbx-readback-v1":
        raise SystemExit("semantic readback schema mismatch")
    source = readback.get("source")
    expected_source = payload["source"]
    if not isinstance(source, dict) or any(
        source.get(key) != expected_source[key]
        for key in ("revisionId", "revisionHash", "s6ValidationHash", "s6HandoffDigest")
    ):
        raise SystemExit("semantic source provenance mismatch")

    nodes = readback.get("nodes")
    if not isinstance(nodes, list):
        raise SystemExit("semantic node collection mismatch")
    roots = [node for node in nodes if isinstance(node, dict) and node.get("name") == "SWZ_ROOT"]
    if not roots:
        raise SystemExit("semantic synthetic root missing")
    if len(roots) != 1:
        raise SystemExit("semantic synthetic root duplicated")
    root = roots[0]
    if "sourceObjectId" in root or "identityKey" in root:
        raise SystemExit("semantic synthetic root provenance forbidden")
    identity = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]
    if (
        set(root) != {"name", "parent", "mesh", "effectiveScale", "nodeToParent", "nodeToWorld"}
        or root.get("parent") is not None
        or root.get("mesh") is not None
        or root.get("effectiveScale") != [1, 1, 1]
        or root.get("nodeToParent") != identity
        or root.get("nodeToWorld") != identity
    ):
        raise SystemExit("semantic synthetic root shape mismatch")

    if len(nodes) != 2:
        raise SystemExit("semantic node cardinality mismatch")
    names = [node.get("name") if isinstance(node, dict) else None for node in nodes]
    if any(not isinstance(name, str) for name in names) or len(set(names)) != 2:
        raise SystemExit("semantic node names are not unique")
    expected_object = payload["objects"][0]
    if set(names) != {"SWZ_ROOT", expected_object["name"]}:
        raise SystemExit("semantic node names mismatch")
    physical = next(node for node in nodes if node.get("name") == expected_object["name"])
    if (
        physical.get("sourceObjectId") != expected_object["sourceObjectId"]
        or physical.get("identityKey") != expected_object["identityKey"]
    ):
        raise SystemExit("semantic object identity mismatch")
    mesh = physical.get("mesh")
    if (
        not isinstance(mesh, dict)
        or len(mesh.get("vertices", [])) != 3
        or mesh.get("triangles") != [[0, 1, 2]]
        or len(mesh.get("cornerNormals", [])) != 3
    ):
        raise SystemExit("semantic geometry mismatch")


def workflow_semantic_checker_control(name, readback, payload, expected_error=None):
    try:
        validate_workflow_semantic_readback(readback, payload)
    except SystemExit as error:
        if expected_error is None or str(error) != expected_error:
            raise SystemExit(
                f"workflow semantic control {name} failed: expected {expected_error!r}, got {str(error)!r}"
            )
    else:
        if expected_error is not None:
            raise SystemExit(
                f"workflow semantic control {name} failed: expected rejection {expected_error!r}"
            )
    print(f"WORKFLOW_SEMANTIC_CONTROL_{name}=PASS")


def validate_workflow_semantic_readback_files(payload_path, readback_path):
    control_source = {
        "revisionId": "semantic-control-revision",
        "revisionHash": "a" * 64,
        "s6ValidationHash": "b" * 64,
        "s6HandoffDigest": "c" * 64,
    }
    control_object = {
        "name": "CONTROL_PHYSICAL",
        "sourceObjectId": "control-source-id",
        "identityKey": "control-identity-key",
    }
    control_payload = {"source": control_source, "objects": [control_object]}
    control_root = {
        "name": "SWZ_ROOT",
        "parent": None,
        "mesh": None,
        "effectiveScale": [1, 1, 1],
        "nodeToParent": [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
        "nodeToWorld": [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
    }
    control_physical = {
        "name": "CONTROL_PHYSICAL",
        "sourceObjectId": "control-source-id",
        "identityKey": "control-identity-key",
        "parent": "SWZ_ROOT",
        "effectiveScale": [1, 1, 1],
        "nodeToParent": [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
        "nodeToWorld": [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
        "mesh": {
            "vertices": [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
            "triangles": [[0, 1, 2]],
            "cornerNormals": [[0, 0, 1]] * 3,
        },
    }
    control_base = {
        "schemaVersion": "s8-ufbx-readback-v1",
        "source": control_source,
        "nodes": [control_root, control_physical],
    }
    workflow_semantic_checker_control("VALID_ROOT_AND_PHYSICAL_NODE", control_base, control_payload)
    workflow_semantic_checker_control(
        "MISSING_ROOT", {**control_base, "nodes": [control_physical]}, control_payload,
        "semantic synthetic root missing",
    )
    workflow_semantic_checker_control(
        "DUPLICATE_ROOT", {**control_base, "nodes": [control_root, dict(control_root), control_physical]},
        control_payload, "semantic synthetic root duplicated",
    )
    workflow_semantic_checker_control(
        "EXTRA_NODE", {**control_base, "nodes": [control_root, control_physical, {"name": "EXTRA", "mesh": None}]},
        control_payload, "semantic node cardinality mismatch",
    )
    malformed_root = dict(control_root)
    malformed_root["parent"] = "CONTROL_PHYSICAL"
    workflow_semantic_checker_control(
        "MALFORMED_ROOT", {**control_base, "nodes": [malformed_root, control_physical]},
        control_payload, "semantic synthetic root shape mismatch",
    )
    root_with_source_id = dict(control_root)
    root_with_source_id["sourceObjectId"] = "SWZ_ROOT"
    workflow_semantic_checker_control(
        "ROOT_SOURCE_OBJECT_ID_PRESENT", {**control_base, "nodes": [root_with_source_id, control_physical]},
        control_payload, "semantic synthetic root provenance forbidden",
    )
    root_with_identity_key = dict(control_root)
    root_with_identity_key["identityKey"] = "SWZ_ROOT"
    workflow_semantic_checker_control(
        "ROOT_IDENTITY_KEY_PRESENT", {**control_base, "nodes": [root_with_identity_key, control_physical]},
        control_payload, "semantic synthetic root provenance forbidden",
    )

    payload = json.loads(Path(payload_path).read_text(encoding="ascii"))
    readback = json.loads(Path(readback_path).read_text(encoding="ascii"))
    validate_workflow_semantic_readback(readback, payload)
    print("SEMANTIC_READBACK_RESULT=PASS")


def main():
    if len(sys.argv) == 4 and sys.argv[1] == "--validate-semantic-readback":
        validate_workflow_semantic_readback_files(Path(sys.argv[2]), Path(sys.argv[3]))
        return
    parser = argparse.ArgumentParser(add_help=False)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--supervise", action="store_true")
    mode.add_argument("--holder", action="store_true")
    parser.add_argument("--mode", choices=("production", "fixture"), default="production")
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--carrier", required=True)
    parser.add_argument("--temp-root", required=True)
    parser.add_argument("--uid", type=int, required=True)
    parser.add_argument("--gid", type=int, required=True)
    parser.add_argument("--node", required=True)
    parser.add_argument("--corepack", required=True)
    parser.add_argument("--control-fd", type=int, default=-1)
    parser.add_argument("--result-fd", type=int, default=-1)
    parser.add_argument("--ledger", default="")
    parser.add_argument("--outer-user-ns", type=int, default=-1)
    parser.add_argument("--outer-pid-ns", type=int, default=-1)
    parser.add_argument("--supervisor-pid", type=int, default=0)
    args = parser.parse_args()
    try:
        if args.holder:
            raise SystemExit(holder_entry(args))
        root_supervise(args)
    except SupervisorFailure as error:
        print("FAILURE_CLASS=HOSTED_NAMESPACE_HARNESS_HOLD", file=sys.stderr)
        print("HARNESS_HOLD_REASON=" + safe_failure(error), file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
