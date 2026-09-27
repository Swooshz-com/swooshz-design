#!/usr/bin/env python3
"""Route-B hosted deployment supervisor and lifecycle regressions.

The root supervisor owns one no-fork mount-namespace holder. The holder keeps
all fixed-path deployment, application, recovery, and cleanup work in that
namespace. The caller-facing sudo policy is mounted privately before it is
installed, so hosted-runner-wide sudo grants cannot satisfy application tests.
"""

import argparse
import errno
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
HOSTED_NODE_TOOLCACHE_ROOT = Path("/opt/hostedtoolcache/node")
ROUTE_B_PRODUCT_LEAF_NAMES = ("blender", "swooshz")
APP_PROOF_RELATIVE = "scripts/s8/s8_application_boundary_proof.mts"
APP_HELPER_RELATIVE = "scripts/s8/s8_application_boundary_proof.sh"
APP_PROOF_BYTES = 8966
APP_PROOF_SHA256 = "05c7b06a96fe0c45be71a4e2805b29202250130c9dba4bb852a0ef6032aacd31"
APP_HELPER_BYTES = 3260
APP_HELPER_SHA256 = "105085a773513c05abdfbc6b0b6da67b74ad8eb811c91c919cc7a08645bd769e"
LEAK_HOLDER_DEADLINE_SECONDS = 1.0
PROCESS_REAP_SECONDS = 5.0
BROKER_TEARDOWN_SECONDS = 35.0
ROOT_CLEANUP_SECONDS = 30.0
NAMESPACE_VERIFY_SECONDS = 10.0
FIXTURE_CANCEL_MODES = ("fixture-opt-cancel", "fixture-application-cancel")
HOLDER_MODE_CHOICES = ("production", "fixture") + FIXTURE_CANCEL_MODES
CURRENT_RESULT_FD = -1
CURRENT_CANCEL_EVENT = None
ROOT_CANCEL_EVENT = threading.Event()


class SupervisorFailure(RuntimeError):
    pass


class Cancelled(SupervisorFailure):
    pass


FIXTURE_BARRIER_EVENT = {
    "kind": "barrier",
    "childrenQuiescent": True,
    "holderReaped": False,
    "outerStateRevalidated": False,
    "complete": False,
}


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
    except Exception as primary_error:
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
            try:
                primary_error.cleanup_failure = cleanup_error
            except Exception:
                pass
        raise primary_error
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


def validate_toolchain_identity(expected, actual):
    required = {"requested", "resolved", "device", "inode", "mode", "size", "sha256"}
    if not isinstance(expected, dict) or not isinstance(actual, dict) or set(expected) != required or set(actual) != required:
        raise SupervisorFailure("HOSTED_TOOLCHAIN_IDENTITY_INVALID")
    if any(type(value[field]) is not int or value[field] < 0 for value in (expected, actual) for field in ("device", "inode", "mode", "size")):
        raise SupervisorFailure("HOSTED_TOOLCHAIN_IDENTITY_INVALID")
    if any(not isinstance(value[field], str) for value in (expected, actual) for field in ("requested", "resolved")):
        raise SupervisorFailure("HOSTED_TOOLCHAIN_IDENTITY_INVALID")
    if any(not re.fullmatch(r"[0-9a-f]{64}", value["sha256"]) for value in (expected, actual)):
        raise SupervisorFailure("HOSTED_TOOLCHAIN_IDENTITY_INVALID")
    if expected != actual:
        raise SupervisorFailure("HOSTED_TOOLCHAIN_IDENTITY_CHANGED")
    return True


def hosted_node_toolcache_installation(path):
    resolved = Path(path)
    if not resolved.is_absolute():
        raise SupervisorFailure("HOSTED_TOOLCHAIN_PATH_NOT_ABSOLUTE")
    try:
        parts = resolved.relative_to(HOSTED_NODE_TOOLCACHE_ROOT).parts
    except ValueError as error:
        raise SupervisorFailure("HOSTED_TOOLCHAIN_SOURCE_OUTSIDE_NODE_TOOLCACHE") from error
    if len(parts) < 4 or not re.fullmatch(r"22\.[0-9]+\.[0-9]+", parts[0]) or parts[1] != "x64":
        raise SupervisorFailure("HOSTED_TOOLCHAIN_NODE_INSTALLATION_INVALID")
    return HOSTED_NODE_TOOLCACHE_ROOT / parts[0] / parts[1]


def derive_toolchain_plan(node_identity, corepack_identity, *, source=None, destination=None):
    try:
        node_path = Path(node_identity["resolved"])
        corepack_path = Path(corepack_identity["resolved"])
    except (KeyError, TypeError) as error:
        raise SupervisorFailure("HOSTED_TOOLCHAIN_IDENTITY_INVALID") from error
    node_installation = hosted_node_toolcache_installation(node_path)
    corepack_installation = hosted_node_toolcache_installation(corepack_path)
    if node_installation != corepack_installation:
        raise SupervisorFailure("HOSTED_TOOLCHAIN_INSTALLATION_MISMATCH")
    try:
        minimal_source = Path(os.path.commonpath((str(node_path), str(corepack_path))))
    except ValueError as error:
        raise SupervisorFailure("HOSTED_TOOLCHAIN_SOURCE_INVALID") from error
    if not minimal_source.is_absolute() or minimal_source == Path("/opt"):
        raise SupervisorFailure("HOSTED_TOOLCHAIN_SOURCE_TOO_BROAD")
    try:
        minimal_source.relative_to(node_installation)
    except ValueError as error:
        raise SupervisorFailure("HOSTED_TOOLCHAIN_SOURCE_OUTSIDE_NODE_INSTALLATION") from error
    selected_source = minimal_source if source is None else Path(source)
    if selected_source != minimal_source:
        raise SupervisorFailure("HOSTED_TOOLCHAIN_SOURCE_NOT_MINIMAL")
    selected_destination = minimal_source if destination is None else Path(destination)
    if selected_destination != minimal_source:
        raise SupervisorFailure("HOSTED_TOOLCHAIN_DESTINATION_INVALID")
    return {
        "installation": str(node_installation),
        "source": str(minimal_source),
        "destination": str(minimal_source),
        "node": node_identity,
        "corepack": corepack_identity,
    }


def toolchain_directory_identity(path):
    target = Path(path)
    try:
        metadata = target.lstat()
    except OSError as error:
        raise SupervisorFailure("HOSTED_TOOLCHAIN_DIRECTORY_UNAVAILABLE") from error
    if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
        raise SupervisorFailure("HOSTED_TOOLCHAIN_DIRECTORY_INVALID")
    return {
        "path": str(target), "device": metadata.st_dev, "inode": metadata.st_ino,
        "uid": metadata.st_uid, "gid": metadata.st_gid, "mode": stat.S_IMODE(metadata.st_mode),
    }


def validate_toolchain_staging_identity(stage_path, expected_identity, observed_identity):
    expected_path = str(Path(stage_path))
    if (
        not isinstance(expected_identity, dict)
        or not isinstance(observed_identity, dict)
        or expected_identity.get("path") != expected_path
        or observed_identity.get("path") != expected_path
    ):
        raise SupervisorFailure("HOSTED_TOOLCHAIN_STAGING_PATH_INVALID")
    if expected_identity != observed_identity:
        raise SupervisorFailure("HOSTED_TOOLCHAIN_STAGING_IDENTITY_CHANGED")
    return True


def validate_toolchain_bind(plan, source_identity, target_identity, mount_rows, *, destination=None):
    expected_destination = Path(plan["destination"])
    actual_destination = expected_destination if destination is None else Path(destination)
    if actual_destination != expected_destination or target_identity.get("path") != str(expected_destination):
        raise SupervisorFailure("HOSTED_TOOLCHAIN_BIND_DESTINATION_INVALID")
    if source_identity.get("path") != plan["source"] or any(
        source_identity.get(field) != target_identity.get(field)
        for field in ("device", "inode", "uid", "gid", "mode")
    ):
        raise SupervisorFailure("HOSTED_TOOLCHAIN_BIND_IDENTITY_MISMATCH")
    matching = [row for row in mount_rows if row.get("mountpoint") == str(expected_destination)]
    if len(matching) != 1:
        raise SupervisorFailure("HOSTED_TOOLCHAIN_BIND_MOUNT_MISSING_OR_AMBIGUOUS")
    row = matching[0]
    expected_device = f"{os.major(source_identity['device'])}:{os.minor(source_identity['device'])}"
    if row.get("device") != expected_device:
        raise SupervisorFailure("HOSTED_TOOLCHAIN_BIND_IDENTITY_MISMATCH")
    flags = set(row.get("mountOptions", []))
    if not {"ro", "nosuid", "nodev"}.issubset(flags) or "rw" in flags or "noexec" in flags:
        raise SupervisorFailure("HOSTED_TOOLCHAIN_BIND_FLAGS_INVALID")
    return True


def validate_toolchain_namespace_release(namespace_closed):
    if namespace_closed is not True:
        raise SupervisorFailure("HOSTED_TOOLCHAIN_NAMESPACE_REFERENCE_REMAINS")
    return True


def validate_unpreserved_toolchain_missing(node_missing, corepack_missing):
    if node_missing is not True or corepack_missing is not True:
        raise SupervisorFailure("HOSTED_TOOLCHAIN_NO_PRESERVATION_NEGATIVE_FALSE_GREEN")
    return True


def verify_toolchain(node, corepack, *, workspace, expected=None):
    node_identity = toolchain_identity(node)
    corepack_identity = toolchain_identity(corepack)
    if expected is not None:
        validate_toolchain_identity(expected["node"], node_identity)
        validate_toolchain_identity(expected["corepack"], corepack_identity)
    host_uid = int(os.environ.get("S8_HOST_UID", str(os.getuid())))
    host_account = host_uid_gid(host_uid, pwd.getpwuid(host_uid).pw_gid)
    env = {"PATH": str(Path(node_identity["resolved"]).parent) + ":/usr/local/bin:/usr/bin:/bin", "HOME": host_account.pw_dir, "COREPACK_HOME": str(Path(host_account.pw_dir) / ".cache/node/corepack"), "COREPACK_ENABLE_AUTO_PIN": "0", "LC_ALL": "C"}
    node_result = supervised_command(app_identity_command(host_uid, host_account.pw_gid, [node_identity["resolved"], "--version"]), cwd=workspace, env=env, label="HOSTED_NODE_VERSION_FAILED")
    if node_result.returncode != 0 or not re.search(rb"(?m)^v22\.[0-9]+\.[0-9]+\s*$", node_result.stdout):
        raise SupervisorFailure("HOSTED_NODE_VERSION_INVALID")
    node_version = node_result.stdout.strip().decode("ascii", errors="strict")
    env["PATH"] = str(Path(corepack_identity["resolved"]).parent) + ":" + str(Path(node_identity["resolved"]).parent) + ":/usr/local/bin:/usr/bin:/bin"
    pnpm_result = supervised_command(app_identity_command(host_uid, host_account.pw_gid, [corepack_identity["resolved"], "pnpm@12.6.0", "--version"]), cwd=workspace, env=env, label="HOSTED_PNPM_VERSION_FAILED", timeout=120)
    if pnpm_result.returncode != 0 or pnpm_result.stdout.strip() != b"12.6.0":
        raise SupervisorFailure("HOSTED_PNPM_VERSION_INVALID")
    pnpm_version = pnpm_result.stdout.strip().decode("ascii", errors="strict")
    validate_toolchain_identity(node_identity, toolchain_identity(node))
    validate_toolchain_identity(corepack_identity, toolchain_identity(corepack))
    return {"node": node_identity, "corepack": corepack_identity, "nodeVersion": node_version, "pnpmVersion": pnpm_version}


def decode_mountinfo_field(value):
    return value.replace("\\040", " ").replace("\\011", "\t").replace("\\012", "\n").replace("\\134", "\\")


def mountinfo_rows():
    rows = []
    for line in Path("/proc/self/mountinfo").read_text(encoding="ascii").splitlines():
        fields = line.split()
        if "-" not in fields:
            raise SupervisorFailure("MOUNTINFO_MALFORMED")
        separator = fields.index("-")
        if separator < 6 or separator + 3 >= len(fields):
            raise SupervisorFailure("MOUNTINFO_MALFORMED")
        rows.append({
            "mountId": fields[0],
            "parentId": fields[1],
            "device": fields[2],
            "root": decode_mountinfo_field(fields[3]),
            "mountpoint": decode_mountinfo_field(fields[4]),
            "mountOptions": fields[5].split(","),
            "optional": fields[6:separator],
            "fstype": fields[separator + 1],
            "source": decode_mountinfo_field(fields[separator + 2]),
            "superOptions": fields[separator + 3].split(","),
            "raw": line,
        })
    by_id = {row["mountId"]: row for row in rows}
    for row in rows:
        parent = by_id.get(row["parentId"])
        row["parentMountpoint"] = parent["mountpoint"] if parent is not None else None
    return rows


def mount_namespace_private():
    rows = mountinfo_rows()
    if any(any(item.startswith(("shared:", "master:", "propagate_from:")) for item in row["optional"]) for row in rows):
        raise SupervisorFailure("MOUNT_PROPAGATION_NOT_RECURSIVELY_PRIVATE")


def opt_mount_rows(rows):
    ancestors = [
        row for row in rows
        if row["mountpoint"] == "/"
        or row["mountpoint"] == "/opt"
        or "/opt".startswith(row["mountpoint"].rstrip("/") + "/")
    ]
    if not ancestors:
        raise SupervisorFailure("OUTER_OPT_MOUNT_VIEW_UNAVAILABLE")
    covering = max(ancestors, key=lambda row: len(row["mountpoint"]))
    selected_ids = {covering["mountId"]}
    selected_ids.update(
        row["mountId"] for row in rows
        if row["mountpoint"] == "/opt" or row["mountpoint"].startswith("/opt/")
    )
    return [row for row in rows if row["mountId"] in selected_ids]


def normalize_opt_mount_view(rows):
    normalized = []
    for row in opt_mount_rows(rows):
        optional = [
            item for item in row["optional"]
            if not item.startswith(("shared:", "master:", "propagate_from:"))
        ]
        normalized.append({
            "device": row["device"],
            "root": row["root"],
            "mountpoint": row["mountpoint"],
            "parentMountpoint": row["parentMountpoint"],
            "mountOptions": list(row["mountOptions"]),
            "optional": optional,
            "fstype": row["fstype"],
            "source": row["source"],
            "superOptions": list(row["superOptions"]),
        })
    return sorted(normalized, key=lambda item: json.dumps(item, sort_keys=True, separators=(",", ":")))


def validate_outer_opt_path_mode(mode):
    if stat.S_ISLNK(mode):
        raise SupervisorFailure("OUTER_OPT_SYMLINK")
    if not stat.S_ISDIR(mode):
        raise SupervisorFailure("OUTER_OPT_NOT_DIRECTORY")


def acl_state(path, name, *, is_symlink=False, failure_category="ACL_STATE_UNREADABLE"):
    if is_symlink:
        return "not-applicable"
    try:
        value = os.getxattr(path, name, follow_symlinks=False)
    except OSError as error:
        missing = {errno.ENODATA, getattr(errno, "ENOATTR", errno.ENODATA)}
        unsupported = {errno.ENOTSUP, errno.EOPNOTSUPP}
        if error.errno in missing:
            return None
        if error.errno in unsupported:
            return "unsupported"
        raise SupervisorFailure(failure_category) from error
    except (AttributeError, TypeError) as error:
        raise SupervisorFailure(failure_category) from error
    return value.hex()


def outer_opt_identity(metadata):
    return {
        "device": metadata.st_dev,
        "inode": metadata.st_ino,
        "uid": metadata.st_uid,
        "gid": metadata.st_gid,
        "mode": stat.S_IMODE(metadata.st_mode),
        "size": metadata.st_size,
        "mtimeNs": metadata.st_mtime_ns,
        "ctimeNs": metadata.st_ctime_ns,
    }


def opt_snapshot():
    root = Path("/opt")
    try:
        before = root.lstat()
    except FileNotFoundError as error:
        raise SupervisorFailure("OUTER_OPT_NOT_DIRECTORY") from error
    validate_outer_opt_path_mode(before.st_mode)
    before_identity = outer_opt_identity(before)
    access_acl = acl_state(root, "system.posix_acl_access", failure_category="OUTER_OPT_ACL_STATE_UNREADABLE")
    default_acl = acl_state(root, "system.posix_acl_default", failure_category="OUTER_OPT_ACL_STATE_UNREADABLE")
    children = []
    try:
        for entry in sorted(os.scandir(root), key=lambda item: item.name):
            metadata = entry.stat(follow_symlinks=False)
            is_symlink = stat.S_ISLNK(metadata.st_mode)
            item = {
                "name": entry.name,
                "device": metadata.st_dev,
                "inode": metadata.st_ino,
                "uid": metadata.st_uid,
                "gid": metadata.st_gid,
                "mode": stat.S_IMODE(metadata.st_mode),
                "size": metadata.st_size,
                "mtimeNs": metadata.st_mtime_ns,
                "ctimeNs": metadata.st_ctime_ns,
                "accessAcl": acl_state(entry.path, "system.posix_acl_access", is_symlink=is_symlink, failure_category="OUTER_OPT_ACL_STATE_UNREADABLE"),
                "defaultAcl": acl_state(entry.path, "system.posix_acl_default", is_symlink=is_symlink, failure_category="OUTER_OPT_ACL_STATE_UNREADABLE"),
            }
            if is_symlink:
                item["target"] = os.readlink(entry.path)
            after_child = Path(entry.path).lstat()
            child_identity = {
                "device": metadata.st_dev, "inode": metadata.st_ino, "uid": metadata.st_uid, "gid": metadata.st_gid,
                "mode": stat.S_IMODE(metadata.st_mode), "size": metadata.st_size,
                "mtimeNs": metadata.st_mtime_ns, "ctimeNs": metadata.st_ctime_ns,
            }
            if outer_opt_identity(after_child) != child_identity:
                raise SupervisorFailure("OUTER_OPT_SNAPSHOT_CHANGED")
            children.append(item)
            if len(children) > 20000:
                raise SupervisorFailure("OUTER_OPT_SNAPSHOT_OVERSIZE")
    except SupervisorFailure:
        raise
    except OSError as error:
        raise SupervisorFailure("OUTER_OPT_SNAPSHOT_UNREADABLE") from error
    after = root.lstat()
    after_access_acl = acl_state(root, "system.posix_acl_access", failure_category="OUTER_OPT_ACL_STATE_UNREADABLE")
    after_default_acl = acl_state(root, "system.posix_acl_default", failure_category="OUTER_OPT_ACL_STATE_UNREADABLE")
    if outer_opt_identity(after) != before_identity or (after_access_acl, after_default_acl) != (access_acl, default_acl):
        raise SupervisorFailure("OUTER_OPT_SNAPSHOT_CHANGED")
    rows = mountinfo_rows()
    relevant_mounts = opt_mount_rows(rows)
    return {
        "fileType": "directory",
        "identity": before_identity,
        "accessAcl": access_acl,
        "defaultAcl": default_acl,
        "children": children,
        "mountView": normalize_opt_mount_view(rows),
        "mounts": tuple(row["raw"] for row in relevant_mounts),
    }


OUTER_OPT_IDENTITY_FIELDS = ("device", "inode", "uid", "gid", "mode", "size", "mtimeNs", "ctimeNs")
OUTER_OPT_REFERENCE_HASH_FIELDS = ("accessAclSha256", "defaultAclSha256", "childrenSha256", "mountViewSha256")


def sha256_json(value):
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("ascii")
    return hashlib.sha256(encoded).hexdigest()


def outer_opt_reference(snapshot):
    identity = {key: snapshot["identity"][key] for key in OUTER_OPT_IDENTITY_FIELDS}
    payload = {
        "schema": "s8-route-b-outer-opt-reference-v1",
        "identity": identity,
        "accessAclSha256": sha256_json(snapshot["accessAcl"]),
        "defaultAclSha256": sha256_json(snapshot["defaultAcl"]),
        "childrenSha256": sha256_json(snapshot["children"]),
        "mountViewSha256": sha256_json(snapshot["mountView"]),
    }
    reference = {**payload, "snapshotSha256": sha256_json(payload)}
    reference["receiptSha256"] = sha256_json(reference)
    return reference


def serialize_outer_opt_reference(snapshot):
    serialized = json.dumps(outer_opt_reference(snapshot), sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    if len(serialized) > 4096:
        raise SupervisorFailure("OUTER_OPT_REFERENCE_OVERSIZE")
    return serialized


def unique_json_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("duplicate object key")
        value[key] = item
    return value


def parse_outer_opt_reference(value):
    if not isinstance(value, str) or not value or len(value) > 4096:
        raise SupervisorFailure("OUTER_OPT_REFERENCE_INVALID")
    try:
        reference = json.loads(value, object_pairs_hook=unique_json_object)
    except (TypeError, ValueError) as error:
        raise SupervisorFailure("OUTER_OPT_REFERENCE_INVALID") from error
    payload_fields = {"schema", "identity", *OUTER_OPT_REFERENCE_HASH_FIELDS}
    expected_fields = payload_fields | {"snapshotSha256", "receiptSha256"}
    if not isinstance(reference, dict) or set(reference) != expected_fields or reference.get("schema") != "s8-route-b-outer-opt-reference-v1":
        raise SupervisorFailure("OUTER_OPT_REFERENCE_INVALID")
    identity = reference.get("identity")
    if not isinstance(identity, dict) or set(identity) != set(OUTER_OPT_IDENTITY_FIELDS):
        raise SupervisorFailure("OUTER_OPT_REFERENCE_INVALID")
    if any(type(identity[field]) is not int or identity[field] < 0 for field in OUTER_OPT_IDENTITY_FIELDS):
        raise SupervisorFailure("OUTER_OPT_REFERENCE_INVALID")
    if identity["mode"] > 0o7777:
        raise SupervisorFailure("OUTER_OPT_REFERENCE_INVALID")
    for field in OUTER_OPT_REFERENCE_HASH_FIELDS + ("snapshotSha256", "receiptSha256"):
        if not isinstance(reference.get(field), str) or not re.fullmatch(r"[0-9a-f]{64}", reference[field]):
            raise SupervisorFailure("OUTER_OPT_REFERENCE_INVALID")
    payload = {field: reference[field] for field in payload_fields}
    if reference["snapshotSha256"] != sha256_json(payload):
        raise SupervisorFailure("OUTER_OPT_REFERENCE_INVALID")
    sealed = {**payload, "snapshotSha256": reference["snapshotSha256"]}
    if reference["receiptSha256"] != sha256_json(sealed):
        raise SupervisorFailure("OUTER_OPT_REFERENCE_INVALID")
    return reference


def validate_outer_opt_snapshot(reference, snapshot):
    if snapshot.get("fileType") == "symlink":
        raise SupervisorFailure("OUTER_OPT_SYMLINK")
    if snapshot.get("fileType") != "directory":
        raise SupervisorFailure("OUTER_OPT_NOT_DIRECTORY")
    current = outer_opt_reference(snapshot)
    for field, reason in (
        ("device", "OUTER_OPT_DEVICE_CHANGED"),
        ("inode", "OUTER_OPT_INODE_CHANGED"),
        ("uid", "OUTER_OPT_UID_CHANGED"),
        ("gid", "OUTER_OPT_GID_CHANGED"),
        ("mode", "OUTER_OPT_MODE_CHANGED"),
    ):
        if current["identity"][field] != reference["identity"][field]:
            raise SupervisorFailure(reason)
    if current["accessAclSha256"] != reference["accessAclSha256"]:
        raise SupervisorFailure("OUTER_OPT_ACCESS_ACL_CHANGED")
    if current["defaultAclSha256"] != reference["defaultAclSha256"]:
        raise SupervisorFailure("OUTER_OPT_DEFAULT_ACL_CHANGED")
    if current["mountViewSha256"] != reference["mountViewSha256"]:
        raise SupervisorFailure("OUTER_OPT_MOUNT_VIEW_CHANGED")
    if current["childrenSha256"] != reference["childrenSha256"]:
        raise SupervisorFailure("OUTER_OPT_CHILDREN_CHANGED")
    if current["identity"] != reference["identity"] or current["snapshotSha256"] != reference["snapshotSha256"]:
        raise SupervisorFailure("OUTER_OPT_METADATA_CHANGED")
    return True


def validate_inner_opt_mount(identity, outer_device, rows, default_acl):
    if identity.get("fileType") != "directory":
        raise SupervisorFailure("ROUTE_B_OPT_DIRECTORY_INVALID")
    if identity.get("device") == outer_device:
        raise SupervisorFailure("ROUTE_B_OPT_FILESYSTEM_NOT_DISTINCT")
    if (identity.get("uid"), identity.get("gid")) != (0, 0):
        raise SupervisorFailure("ROUTE_B_OPT_OWNER_INVALID")
    if identity.get("mode") != 0o755:
        raise SupervisorFailure("ROUTE_B_OPT_MODE_INVALID")
    if len(rows) != 1 or rows[0].get("fstype") != "tmpfs" or rows[0].get("source") != "tmpfs":
        raise SupervisorFailure("ROUTE_B_OPT_MOUNT_IDENTITY_INVALID")
    if "rw" not in rows[0].get("mountOptions", []):
        raise SupervisorFailure("ROUTE_B_OPT_MOUNT_STATE_INVALID")
    mount_flags = set(rows[0].get("mountOptions", [])) | set(rows[0].get("superOptions", []))
    if not {"nosuid", "nodev"}.issubset(mount_flags):
        raise SupervisorFailure("ROUTE_B_OPT_MOUNT_FLAGS_INVALID")
    if default_acl is not None:
        raise SupervisorFailure("ROUTE_B_OPT_DEFAULT_ACL_INVALID")
    return True


def validate_inner_opt_child(identity, inner_device, default_acl):
    if identity.get("fileType") != "directory" or identity.get("device") != inner_device:
        raise SupervisorFailure("ROUTE_B_OPT_CHILD_IDENTITY_INVALID")
    if (identity.get("uid"), identity.get("gid"), identity.get("mode")) != (0, 0, 0o755):
        raise SupervisorFailure("ROUTE_B_OPT_CHILD_MODE_INVALID")
    if default_acl is not None:
        raise SupervisorFailure("ROUTE_B_OPT_CHILD_DEFAULT_ACL_INVALID")
    return True


def route_b_path_identity(path):
    metadata = Path(path).lstat()
    if stat.S_ISLNK(metadata.st_mode):
        file_type = "symlink"
    elif stat.S_ISDIR(metadata.st_mode):
        file_type = "directory"
    elif stat.S_ISREG(metadata.st_mode):
        file_type = "file"
    elif stat.S_ISFIFO(metadata.st_mode):
        file_type = "fifo"
    else:
        file_type = "other"
    return {
        "fileType": file_type,
        "device": metadata.st_dev,
        "inode": metadata.st_ino,
        "uid": metadata.st_uid,
        "gid": metadata.st_gid,
        "mode": stat.S_IMODE(metadata.st_mode),
    }


def route_b_product_leaf_paths(inner_root):
    root = Path(inner_root)
    if not root.is_absolute() or root == Path("/"):
        raise SupervisorFailure("ROUTE_B_PRODUCT_LEAF_ROOT_INVALID")
    return tuple(root / name for name in ROUTE_B_PRODUCT_LEAF_NAMES)


def validate_trusted_inner_opt_identity(inner_root, expected_identity):
    current = route_b_path_identity(inner_root)
    identity_fields = ("fileType", "device", "inode", "uid", "gid", "mode")
    if any(current[field] != expected_identity.get(field) for field in identity_fields):
        raise SupervisorFailure("ROUTE_B_INNER_OPT_IDENTITY_CHANGED")
    default_acl = acl_state(
        Path(inner_root), "system.posix_acl_default",
        failure_category="ROUTE_B_OPT_ACL_STATE_UNREADABLE",
    )
    if default_acl is not None or expected_identity.get("defaultAcl") is not None:
        raise SupervisorFailure("ROUTE_B_OPT_DEFAULT_ACL_INVALID")
    return True


def validate_product_leaf_absence_state(path, file_type, is_mountpoint):
    if file_type is not None or is_mountpoint:
        raise SupervisorFailure("HOSTED_PRODUCT_LEAF_NOT_FRESH:" + str(path))
    return True


def validate_product_leaves_absent(inner_root, expected_inner_identity, *, mounted_paths=None):
    root = Path(inner_root)
    validate_trusted_inner_opt_identity(root, expected_inner_identity)
    mountpoints = (
        {row["mountpoint"] for row in mountinfo_rows()}
        if mounted_paths is None else set(mounted_paths)
    )
    for path in route_b_product_leaf_paths(root):
        try:
            identity = route_b_path_identity(path)
        except FileNotFoundError:
            file_type = None
        except OSError as error:
            raise SupervisorFailure("HOSTED_PRODUCT_LEAF_STATE_UNREADABLE:" + str(path)) from error
        else:
            file_type = identity["fileType"]
        validate_product_leaf_absence_state(path, file_type, str(path) in mountpoints)
    return True


def validate_product_leaf_identity(path, inner_root, expected_inner_identity, identity, default_acl):
    leaf_path = Path(path)
    if leaf_path not in route_b_product_leaf_paths(inner_root):
        raise SupervisorFailure("ROUTE_B_PRODUCT_LEAF_PATH_INVALID")
    if identity.get("fileType") != "directory":
        raise SupervisorFailure("ROUTE_B_PRODUCT_LEAF_TYPE_INVALID")
    if identity.get("device") != expected_inner_identity.get("device"):
        raise SupervisorFailure("ROUTE_B_PRODUCT_LEAF_DEVICE_INVALID")
    if (identity.get("uid"), identity.get("gid")) != (0, 0):
        raise SupervisorFailure("ROUTE_B_PRODUCT_LEAF_OWNER_INVALID")
    if identity.get("mode") != 0o755:
        raise SupervisorFailure("ROUTE_B_PRODUCT_LEAF_MODE_INVALID")
    if default_acl is not None:
        raise SupervisorFailure("ROUTE_B_PRODUCT_LEAF_DEFAULT_ACL_INVALID")
    return True


def validate_product_leaves_deployed(inner_root, expected_inner_identity, *, mounted_paths=None):
    root = Path(inner_root)
    validate_trusted_inner_opt_identity(root, expected_inner_identity)
    mountpoints = (
        {row["mountpoint"] for row in mountinfo_rows()}
        if mounted_paths is None else set(mounted_paths)
    )
    for path in route_b_product_leaf_paths(root):
        if str(path) in mountpoints:
            raise SupervisorFailure("ROUTE_B_PRODUCT_LEAF_MOUNTPOINT_INVALID")
        try:
            identity = route_b_path_identity(path)
        except FileNotFoundError as error:
            raise SupervisorFailure("ROUTE_B_PRODUCT_LEAF_MISSING") from error
        except OSError as error:
            raise SupervisorFailure("ROUTE_B_PRODUCT_LEAF_STATE_UNREADABLE") from error
        default_acl = acl_state(
            path, "system.posix_acl_default",
            failure_category="ROUTE_B_PRODUCT_LEAF_ACL_STATE_UNREADABLE",
        )
        validate_product_leaf_identity(path, root, expected_inner_identity, identity, default_acl)
    return True


def create_toolchain_stage_root(temp_root):
    state_dir = Path(temp_root) / ".namespace-state"
    metadata = state_dir.lstat()
    if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode) or (metadata.st_uid, metadata.st_gid, stat.S_IMODE(metadata.st_mode)) != (0, 0, 0o700):
        raise SupervisorFailure("HOSTED_TOOLCHAIN_STAGE_PARENT_INVALID")
    root = Path(tempfile.mkdtemp(prefix="toolchain-stage-", dir=state_dir))
    target = root / "tree"
    try:
        os.chown(root, 0, 0)
        os.chmod(root, 0o700)
        target.mkdir(mode=0o700)
        os.chown(target, 0, 0)
        os.chmod(target, 0o700)
        return root
    except Exception:
        if target.exists() and not target.is_symlink() and not list(target.iterdir()):
            target.rmdir()
        if root.exists() and not root.is_symlink() and not list(root.iterdir()):
            root.rmdir()
        raise


def validate_toolchain_stage_root(temp_root, stage_root):
    root = Path(stage_root)
    state_dir = Path(temp_root) / ".namespace-state"
    if not root.is_absolute() or root.parent != state_dir or root == Path("/opt") or Path("/opt") in root.parents:
        raise SupervisorFailure("HOSTED_TOOLCHAIN_STAGE_PATH_INVALID")
    metadata = root.lstat()
    if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode) or (metadata.st_uid, metadata.st_gid, stat.S_IMODE(metadata.st_mode)) != (0, 0, 0o700):
        raise SupervisorFailure("HOSTED_TOOLCHAIN_STAGE_ROOT_IDENTITY_INVALID")
    target = root / "tree"
    target_metadata = target.lstat()
    if not stat.S_ISDIR(target_metadata.st_mode) or stat.S_ISLNK(target_metadata.st_mode) or (target_metadata.st_uid, target_metadata.st_gid, stat.S_IMODE(target_metadata.st_mode)) != (0, 0, 0o700):
        raise SupervisorFailure("HOSTED_TOOLCHAIN_STAGE_TARGET_IDENTITY_INVALID")
    return target


def cleanup_toolchain_stage_root(temp_root, stage_root, *, namespace_closed):
    validate_toolchain_namespace_release(namespace_closed)
    root = Path(stage_root)
    target = validate_toolchain_stage_root(temp_root, root)
    mountpoints = {row["mountpoint"] for row in mountinfo_rows()}
    if str(root) in mountpoints or str(target) in mountpoints:
        raise SupervisorFailure("HOSTED_TOOLCHAIN_STAGE_MOUNT_REFERENCE_REMAINS")
    if list(root.iterdir()) != [target] or list(target.iterdir()):
        raise SupervisorFailure("HOSTED_TOOLCHAIN_STAGE_RESOURCE_NOT_EMPTY")
    target.rmdir()
    root.rmdir()
    if root.exists() or root.is_symlink():
        raise SupervisorFailure("HOSTED_TOOLCHAIN_STAGE_RESOURCE_REMAINS")


def require_mount_row(path, label):
    matching = [row for row in mountinfo_rows() if row["mountpoint"] == str(path)]
    if len(matching) != 1:
        raise SupervisorFailure(label)
    return matching[0]


def create_inner_toolchain_parent_directories(destination):
    target = Path(destination)
    if not target.is_absolute() or str(target).startswith("/opt/") is False or target == Path("/opt"):
        raise SupervisorFailure("HOSTED_TOOLCHAIN_DESTINATION_INVALID")
    parents = [path for path in reversed(target.parents) if path != Path("/") and path != Path("/opt")]
    for path in parents:
        try:
            path.mkdir(mode=0o755)
        except FileExistsError as error:
            raise SupervisorFailure("HOSTED_TOOLCHAIN_DESTINATION_PARENT_NOT_FRESH") from error
        os.chown(path, 0, 0)
        os.chmod(path, 0o755)
        metadata = path.lstat()
        default_acl = acl_state(path, "system.posix_acl_default", failure_category="HOSTED_TOOLCHAIN_DESTINATION_ACL_UNREADABLE")
        identity = {
            "fileType": "directory" if stat.S_ISDIR(metadata.st_mode) and not stat.S_ISLNK(metadata.st_mode) else "other",
            "device": metadata.st_dev, "uid": metadata.st_uid, "gid": metadata.st_gid,
            "mode": stat.S_IMODE(metadata.st_mode),
        }
        validate_inner_opt_child(identity, os.stat("/opt").st_dev, default_acl)
    try:
        target.mkdir(mode=0o755)
    except FileExistsError as error:
        raise SupervisorFailure("HOSTED_TOOLCHAIN_DESTINATION_NOT_FRESH") from error
    os.chown(target, 0, 0)
    os.chmod(target, 0o755)
    metadata = target.lstat()
    default_acl = acl_state(target, "system.posix_acl_default", failure_category="HOSTED_TOOLCHAIN_DESTINATION_ACL_UNREADABLE")
    identity = {
        "fileType": "directory" if stat.S_ISDIR(metadata.st_mode) and not stat.S_ISLNK(metadata.st_mode) else "other",
        "device": metadata.st_dev, "uid": metadata.st_uid, "gid": metadata.st_gid,
        "mode": stat.S_IMODE(metadata.st_mode),
    }
    validate_inner_opt_child(identity, os.stat("/opt").st_dev, default_acl)
    return target


def toolchain_bind_evidence(row):
    flags = set(row.get("mountOptions", []))
    return {
        "mountId": row.get("mountId"), "readOnly": "ro" in flags and "rw" not in flags,
        "executable": "noexec" not in flags, "nosuid": "nosuid" in flags, "nodev": "nodev" in flags,
    }


def validate_toolchain_preservation_events(events, namespace_number, stage_root):
    rows = [event for event in events if event.get("kind") == "toolchainPreservation"]
    phases = [event.get("phase") for event in rows]
    expected_phases = ["PREMOUNT_IDENTITY", "STAGING_BIND", "NO_BIND_NEGATIVE", "INNER_BIND", "STAGING_RELEASED", "CONTINUITY"]
    if phases != expected_phases or any(event.get("mountNamespace") != namespace_number for event in rows):
        raise SupervisorFailure("HOSTED_TOOLCHAIN_RESOURCE_LEDGER_INVALID")
    premount, staging, negative, inner, released, continuity = rows
    node = premount.get("node")
    corepack = premount.get("corepack")
    validate_toolchain_identity(node, node)
    validate_toolchain_identity(corepack, corepack)
    plan = derive_toolchain_plan(node, corepack)
    if premount.get("plan") != plan or premount.get("sourceIdentity", {}).get("path") != plan["source"]:
        raise SupervisorFailure("HOSTED_TOOLCHAIN_RESOURCE_SOURCE_INVALID")
    expected_stage = Path(stage_root) / "tree"
    if staging.get("stagePath") != str(expected_stage) or staging.get("sourceIdentity") != premount.get("sourceIdentity"):
        raise SupervisorFailure("HOSTED_TOOLCHAIN_STAGING_RESOURCE_INVALID")
    source_identity = premount["sourceIdentity"]
    staged_identity = staging.get("stagedIdentity", {})
    if any(source_identity.get(field) != staged_identity.get(field) for field in ("device", "inode", "uid", "gid", "mode")):
        raise SupervisorFailure("HOSTED_TOOLCHAIN_STAGING_IDENTITY_CONTINUITY_INVALID")
    stage_mount = staging.get("mount")
    if not isinstance(stage_mount, dict) or not isinstance(stage_mount.get("mountId"), str) or not stage_mount["mountId"].isdigit() or not all(stage_mount.get(key) is True for key in ("readOnly", "executable", "nosuid", "nodev")):
        raise SupervisorFailure("HOSTED_TOOLCHAIN_STAGING_BIND_FLAGS_INVALID")
    if negative.get("nodeMissing") is not True or negative.get("corepackMissing") is not True:
        raise SupervisorFailure("HOSTED_TOOLCHAIN_NO_PRESERVATION_CONTROL_MISSING")
    if inner.get("stagingPath") != str(expected_stage) or inner.get("stagingIdentityAfterOverlay") != staged_identity:
        raise SupervisorFailure("HOSTED_TOOLCHAIN_STAGING_IDENTITY_CONTINUITY_INVALID")
    destination_identity = inner.get("destinationIdentity", {})
    if inner.get("destination") != plan["destination"] or inner.get("sourceIdentity") != source_identity or any(source_identity.get(field) != destination_identity.get(field) for field in ("device", "inode", "uid", "gid", "mode")):
        raise SupervisorFailure("HOSTED_TOOLCHAIN_INNER_RESOURCE_INVALID")
    inner_mount = inner.get("mount")
    if not isinstance(inner_mount, dict) or not isinstance(inner_mount.get("mountId"), str) or not inner_mount["mountId"].isdigit() or inner_mount["mountId"] == stage_mount["mountId"] or not all(inner_mount.get(key) is True for key in ("readOnly", "executable", "nosuid", "nodev")):
        raise SupervisorFailure("HOSTED_TOOLCHAIN_INNER_BIND_FLAGS_INVALID")
    if released.get("stagePath") != str(expected_stage) or released.get("mountId") != stage_mount.get("mountId") or released.get("mountAbsent") is not True:
        raise SupervisorFailure("HOSTED_TOOLCHAIN_STAGING_RELEASE_INVALID")
    if staging.get("mountpointIdentity") != released.get("mountpointIdentity"):
        raise SupervisorFailure("HOSTED_TOOLCHAIN_STAGING_MOUNTPOINT_IDENTITY_CHANGED")
    validate_toolchain_identity(node, continuity.get("node"))
    validate_toolchain_identity(corepack, continuity.get("corepack"))
    if not re.fullmatch(r"v22\.[0-9]+\.[0-9]+", continuity.get("nodeVersion", "")) or continuity.get("pnpmVersion") != "12.6.0":
        raise SupervisorFailure("HOSTED_TOOLCHAIN_VERSION_CONTINUITY_INVALID")
    return True


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


def application_source_identity_matches(proof_bytes, helper_bytes):
    return (
        len(proof_bytes) == APP_PROOF_BYTES
        and hashlib.sha256(proof_bytes).hexdigest() == APP_PROOF_SHA256
        and len(helper_bytes) == APP_HELPER_BYTES
        and hashlib.sha256(helper_bytes).hexdigest() == APP_HELPER_SHA256
    )


def application_proof(workspace, carrier, temp_root, node, corepack, uid, gid, policy_h, config_q, ledger_path, mount_id, cancel_event):
    proof_path = Path(workspace) / APP_PROOF_RELATIVE
    helper_path = Path(workspace) / APP_HELPER_RELATIVE
    proof_bytes = proof_path.read_bytes()
    helper_bytes = helper_path.read_bytes()
    if not application_source_identity_matches(proof_bytes, helper_bytes):
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
        if not application_source_identity_matches(
            (Path(workspace) / APP_PROOF_RELATIVE).read_bytes(),
            (Path(workspace) / APP_HELPER_RELATIVE).read_bytes(),
        ):
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


def private_opt_mount(outer_opt_reference, ledger_path, mount_id, node, corepack, workspace, temp_root, stage_root, result_fd):
    mount_namespace_private()
    current_outer = opt_snapshot()
    validate_outer_opt_snapshot(outer_opt_reference, current_outer)
    outer_device = outer_opt_reference["identity"]["device"]
    stage_target = validate_toolchain_stage_root(temp_root, stage_root)
    node_identity = toolchain_identity(node)
    corepack_identity = toolchain_identity(corepack)
    plan = derive_toolchain_plan(node_identity, corepack_identity)
    source_identity = toolchain_directory_identity(plan["source"])
    emit(result_fd, "toolchainPreservation", phase="PREMOUNT_IDENTITY", mountNamespace=mount_id, node=node_identity, corepack=corepack_identity, plan=plan, sourceIdentity=source_identity)
    emit_to_stdout("HOSTED_TOOLCHAIN_PREMOUNT_IDENTITY=PASS\n")

    stage_mountpoint_identity = toolchain_directory_identity(stage_target)
    supervised_command(["/usr/bin/mount", "--bind", plan["source"], str(stage_target)], label="HOSTED_TOOLCHAIN_STAGING_BIND_FAILED", timeout=20)
    supervised_command(["/usr/bin/mount", "-o", "remount,bind,ro,nosuid,nodev", str(stage_target)], label="HOSTED_TOOLCHAIN_STAGING_READONLY_FAILED", timeout=20)
    staged_identity = toolchain_directory_identity(stage_target)
    stage_plan = dict(plan, destination=str(stage_target))
    stage_row = require_mount_row(stage_target, "HOSTED_TOOLCHAIN_STAGING_MOUNT_IDENTITY_INVALID")
    validate_toolchain_bind(stage_plan, source_identity, staged_identity, [stage_row])
    stage_evidence = toolchain_bind_evidence(stage_row)
    if not all(stage_evidence[key] for key in ("readOnly", "executable", "nosuid", "nodev")):
        raise SupervisorFailure("HOSTED_TOOLCHAIN_STAGING_BIND_FLAGS_INVALID")
    emit(result_fd, "toolchainPreservation", phase="STAGING_BIND", mountNamespace=mount_id, stagePath=str(stage_target), sourceIdentity=source_identity, stagedIdentity=staged_identity, mountpointIdentity=stage_mountpoint_identity, mount=stage_evidence)
    emit_to_stdout("HOSTED_TOOLCHAIN_STAGING_BIND=PASS\n")

    supervised_command(["/usr/bin/mount", "-t", "tmpfs", "-o", "size=4G,mode=0755,nosuid,nodev", "tmpfs", "/opt"], label="ROUTE_B_OPT_MOUNT_FAILED", timeout=20)
    inner_path = Path("/opt")
    rows = [row for row in mountinfo_rows() if row["mountpoint"] == "/opt"]
    default_acl = acl_state(inner_path, "system.posix_acl_default", failure_category="ROUTE_B_OPT_ACL_STATE_UNREADABLE")
    inner_identity = route_b_path_identity(inner_path)
    inner_identity["defaultAcl"] = default_acl
    validate_inner_opt_mount(inner_identity, outer_device, rows, default_acl)

    missing = []
    for name, executable in (("node", node), ("corepack", corepack)):
        try:
            toolchain_identity(executable)
        except FileNotFoundError:
            missing.append(name)
    node_missing = "node" in missing
    corepack_missing = "corepack" in missing
    validate_unpreserved_toolchain_missing(node_missing, corepack_missing)
    emit(result_fd, "toolchainPreservation", phase="NO_BIND_NEGATIVE", mountNamespace=mount_id, nodeMissing=node_missing, corepackMissing=corepack_missing)
    emit_to_stdout("HOSTED_TOOLCHAIN_NO_PRESERVATION=REPRODUCED_MISSING\n")

    post_mount_staging_identity = toolchain_directory_identity(stage_target)
    validate_toolchain_staging_identity(stage_target, staged_identity, post_mount_staging_identity)
    destination = create_inner_toolchain_parent_directories(plan["destination"])
    supervised_command(["/usr/bin/mount", "--bind", str(stage_target), str(destination)], label="HOSTED_TOOLCHAIN_INNER_BIND_FAILED", timeout=20)
    supervised_command(["/usr/bin/mount", "-o", "remount,bind,ro,nosuid,nodev", str(destination)], label="HOSTED_TOOLCHAIN_INNER_READONLY_FAILED", timeout=20)
    destination_identity = toolchain_directory_identity(destination)
    destination_plan = dict(plan, destination=str(destination))
    destination_row = require_mount_row(destination, "HOSTED_TOOLCHAIN_INNER_MOUNT_IDENTITY_INVALID")
    validate_toolchain_bind(destination_plan, source_identity, destination_identity, [destination_row])
    destination_evidence = toolchain_bind_evidence(destination_row)
    if not all(destination_evidence[key] for key in ("readOnly", "executable", "nosuid", "nodev")):
        raise SupervisorFailure("HOSTED_TOOLCHAIN_INNER_BIND_FLAGS_INVALID")
    emit(result_fd, "toolchainPreservation", phase="INNER_BIND", mountNamespace=mount_id, destination=str(destination), stagingPath=str(stage_target), stagingIdentityAfterOverlay=post_mount_staging_identity, sourceIdentity=source_identity, destinationIdentity=destination_identity, mount=destination_evidence)
    emit_to_stdout("HOSTED_TOOLCHAIN_INNER_BIND=READ_ONLY\n")

    supervised_command(["/usr/bin/umount", "--", str(stage_target)], label="HOSTED_TOOLCHAIN_STAGING_UNMOUNT_FAILED", timeout=20)
    remaining_stage_rows = [row for row in mountinfo_rows() if row["mountpoint"] == str(stage_target)]
    if remaining_stage_rows or toolchain_directory_identity(stage_target) != stage_mountpoint_identity or list(stage_target.iterdir()):
        raise SupervisorFailure("HOSTED_TOOLCHAIN_STAGING_MOUNT_REFERENCE_REMAINS")
    emit(result_fd, "toolchainPreservation", phase="STAGING_RELEASED", mountNamespace=mount_id, stagePath=str(stage_target), mountId=stage_evidence["mountId"], mountAbsent=True, mountpointIdentity=stage_mountpoint_identity)
    emit_to_stdout("HOSTED_TOOLCHAIN_STAGING_UNMOUNT=PASS\n")

    toolchain = verify_toolchain(node, corepack, workspace=workspace, expected={"node": node_identity, "corepack": corepack_identity})
    emit(result_fd, "toolchainPreservation", phase="CONTINUITY", mountNamespace=mount_id, node=toolchain["node"], corepack=toolchain["corepack"], nodeVersion=toolchain["nodeVersion"], pnpmVersion=toolchain["pnpmVersion"])
    emit_to_stdout("HOSTED_TOOLCHAIN_IDENTITY_CONTINUITY=PASS\nHOSTED_TOOLCHAIN_CONTINUITY=PASS\nHOSTED_TOOLCACHE_PRODUCT_AUTHORITY=ABSENT\n")
    toolchain["innerOptIdentity"] = inner_identity
    emit_to_stdout("ROUTE_B_INNER_OPT=ROOT_ROOT_0755\nROUTE_B_OPT_FILESYSTEM=DISTINCT_TMPFS\n")
    return toolchain


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


def prepare_cancellation_fixture(mode, workspace, temp_root, uid, gid, ledger_path, mount_ns, outer_opt_reference, node, corepack, stage_root, result_fd, cancel_event, release_event):
    workload = None
    primary_failure = None
    cleanup_failure = None
    try:
        private_opt_mount(outer_opt_reference, Path(ledger_path), mount_ns["number"], node, corepack, workspace, temp_root, stage_root, result_fd)
        runner = host_uid_gid(uid, gid)
        fixture_log = Path(temp_root) / ".namespace-state" / (mode + ".log")
        fixture_env = {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": runner.pw_dir, "USER": runner.pw_name, "LOGNAME": runner.pw_name, "LC_ALL": "C"}
        fixture_code = "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); print('S8_CANCELLATION_CHILD_READY', flush=True); time.sleep(3600)"
        workload = launch_owned_to_log(
            app_identity_command(uid, gid, ["/usr/bin/python3", "-c", fixture_code]), log_path=fixture_log,
            owner=f"namespace-holder:{os.getpid()}:{mode}-workload",
            ledger_path=ledger_path, mount_id=mount_ns["number"], cwd=workspace, env=fixture_env,
        )
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
    except Exception as error:
        primary_failure = error

    if workload is not None and workload.terminal is None:
        try:
            if workload.process.poll() is None:
                terminate_owned(workload)
            else:
                workload.wait(0)
        except Exception as error:
            cleanup_failure = error

    if primary_failure is not None or cleanup_failure is not None:
        raise FixtureSetupFailure("CANCELLATION_STAGE_SETUP_FAILURE", primary_failure, cleanup_failure)


def inner_holder(workspace, carrier, temp_root, uid, gid, node, corepack, control_fd, result_fd, ledger_path, outer_user_ns, outer_pid_ns, mode, outer_opt_reference, stage_root):
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
        try:
            if user_ns["number"] != outer_user_ns or pid_ns["number"] != outer_pid_ns:
                raise SupervisorFailure("FIXTURE_USER_OR_PID_NAMESPACE_CHANGED")
            supervised_command(["/usr/bin/mount", "--make-rprivate", "/"], label="FIXTURE_PRIVATE_PROPAGATION_FAILED", timeout=10)
            mount_namespace_private()
            emit(result_fd, "ready", pid=os.getpid(), mountNamespace=mount_ns["number"], userNamespace=user_ns["number"], pidNamespace=pid_ns["number"])
            emit(result_fd, "barrier", childrenQuiescent=True, holderReaped=False, outerStateRevalidated=False, complete=False)
            os.close(result_fd)
        except Exception as error:
            raise FixtureSetupFailure("NAMESPACE_SETUP_FAILURE", error) from error
        while not release_event.wait(0.05):
            if cancel_event.is_set():
                return 143
        return 0
    if mode in {"fixture-opt-cancel", "fixture-application-cancel"}:
        if user_ns["number"] != outer_user_ns or pid_ns["number"] != outer_pid_ns:
            raise SupervisorFailure("FIXTURE_USER_OR_PID_NAMESPACE_CHANGED")
        supervised_command(["/usr/bin/mount", "--make-rprivate", "/"], label="FIXTURE_PRIVATE_PROPAGATION_FAILED", timeout=10)
        mount_namespace_private()
        try:
            prepare_cancellation_fixture(mode, workspace, temp_root, uid, gid, ledger_path, mount_ns, outer_opt_reference, node, corepack, stage_root, result_fd, cancel_event, release_event)
            emit(result_fd, "ready", pid=os.getpid(), mountNamespace=mount_ns["number"], userNamespace=user_ns["number"], pidNamespace=pid_ns["number"])
            emit(result_fd, "barrier", childrenQuiescent=True, holderReaped=False, outerStateRevalidated=False, complete=False)
            os.close(result_fd)
        except FixtureSetupFailure:
            raise
        except Exception as error:
            raise FixtureSetupFailure("CANCELLATION_STAGE_SETUP_FAILURE", error) from error
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
        toolchain = private_opt_mount(outer_opt_reference, ledger_path, mount_ns["number"], node, corepack, workspace, temp_root, stage_root, result_fd)
        emit(result_fd, "stage", name="OPT_MOUNTED")
        require_not_cancelled(cancel_event, "AFTER_OPT_MOUNT")
        emit(result_fd, "stage", name="TOOLCHAIN_BOUND", node=toolchain["node"]["sha256"], corepack=toolchain["corepack"]["sha256"])
        require_not_cancelled(cancel_event, "AFTER_TOOLCHAIN")
        create_namespace_sudoers(temp_root, ledger_path, mount_ns["number"])
        require_not_cancelled(cancel_event, "BEFORE_BROKER_DEPLOYMENT")
        inner_opt_identity = toolchain["innerOptIdentity"]
        validate_product_leaves_absent(Path("/opt"), inner_opt_identity)
        emit_to_stdout("HOSTED_PRODUCT_LEAVES_ABSENT_BEFORE_DEPLOY=YES\n")
        deployment_attempted = True
        emit(result_fd, "stage", name="BROKER_DEPLOYMENT_ATTEMPTED")
        deployment_output = run_hosted_contract(workspace, carrier, temp_root, uid, gid, ledger_path, mount_ns["number"], "deploy", cancel_event=cancel_event)
        validate_product_leaves_deployed(Path("/opt"), inner_opt_identity)
        emit_to_stdout("ROUTE_B_PRODUCT_LEAF_DEPLOYMENT_IDENTITY=PASS\n")
        policy_h = parse_one(deployment_output, "HOSTED_POLICY_H")
        config_q = parse_one(deployment_output, "HOSTED_CONFIG_Q")
        emit(result_fd, "stage", name="DEPLOYED", policyH=policy_h, configQ=config_q)
        run_sudo_matrix(uid, gid, workspace, temp_root, policy_h, config_q, ledger_path, mount_ns["number"])
        emit(result_fd, "stage", name="APPLICATION_RUNNING")
        application_proof(workspace, carrier, temp_root, node, corepack, uid, gid, policy_h, config_q, ledger_path, mount_ns["number"], cancel_event)
    except Exception as error:
        primary_error = error
        emit(
            result_fd, "failure", category="HOLDER_OPERATION_FAILURE",
            reason=safe_failure(error), primaryFailure=safe_failure(error), cleanupFailure="NONE",
        )
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
                cleanup_reason = "HOSTED_RECOVERY_CLEANUP_FAILED:" + safe_failure(error)
                emit(
                    result_fd, "failure", category="HOLDER_CLEANUP_FAILURE",
                    reason=cleanup_reason,
                    primaryFailure=safe_failure(primary_error) if primary_error is not None else "NONE",
                    cleanupFailure=safe_failure(error),
                )
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


class FixtureSetupFailure(SupervisorFailure):
    def __init__(self, category, primary_failure, cleanup_failure=None):
        self.category = category
        self.primary_failure = primary_failure
        self.cleanup_failure = cleanup_failure
        primary, cleanup = failure_pair_labels(primary_failure, cleanup_failure)
        detail = primary if primary != "NONE" else cleanup
        super().__init__(category + ":" + detail)


def holder_launch_failure(primary_failure, cleanup_failure=None):
    if isinstance(primary_failure, FixtureSetupFailure):
        cleanup_failure = cleanup_failure or primary_failure.cleanup_failure
        primary_failure = primary_failure.primary_failure
    return FixtureSetupFailure("HOLDER_LAUNCH_OR_SETUP_FAILURE", primary_failure, cleanup_failure)


def launch_fixture_holder(launcher, *args, **kwargs):
    try:
        return launcher(*args, **kwargs)
    except FixtureSetupFailure as error:
        if error.category.startswith("HOLDER_LAUNCH_OR_SETUP_FAILURE"):
            raise
        raise holder_launch_failure(error) from error
    except Exception as error:
        raise holder_launch_failure(error, getattr(error, "cleanup_failure", None)) from error


def failure_pair_labels(primary_failure, cleanup_failure=None):
    nested_cleanups = []
    if primary_failure is not None:
        for attribute in ("cleanup_failure", "supervisor_cleanup_failure"):
            nested_cleanup = getattr(primary_failure, attribute, None)
            if nested_cleanup is not None and all(nested_cleanup is not existing for existing in nested_cleanups):
                nested_cleanups.append(nested_cleanup)
    if isinstance(primary_failure, FixtureSetupFailure):
        if primary_failure.cleanup_failure is not None and all(primary_failure.cleanup_failure is not existing for existing in nested_cleanups):
            nested_cleanups.append(primary_failure.cleanup_failure)
        primary_failure = primary_failure.primary_failure
    if primary_failure is None:
        primary = "NONE"
    else:
        primary = safe_failure(primary_failure)
    cleanups = nested_cleanups + ([cleanup_failure] if cleanup_failure is not None else [])
    cleanup = "__AND__".join(safe_failure(item) for item in cleanups) if cleanups else "NONE"
    return primary, cleanup


def combined_failure(errors):
    if not errors:
        return None
    if len(errors) == 1:
        return errors[0]
    return SupervisorFailure("__AND__".join(safe_failure(error) for error in errors))


def append_cleanup_failure(existing, new_failure):
    return new_failure if existing is None else combined_failure([existing, new_failure])


def report_failure_pair(primary_failure, cleanup_failure=None):
    primary, cleanup = failure_pair_labels(primary_failure, cleanup_failure)
    emit_to_stdout("PRIMARY_FAILURE=" + primary + "\nCLEANUP_FAILURE=" + cleanup + "\n")


def effective_failure(primary_failure, cleanup_failure):
    return primary_failure if primary_failure is not None else cleanup_failure


def emit_fixture_failure(result_fd, category, primary_failure, cleanup_failure=None):
    primary, cleanup = failure_pair_labels(primary_failure, cleanup_failure)
    reason = primary if primary != "NONE" else cleanup
    emit(
        result_fd, "failure", category=category, reason=reason,
        primaryFailure=primary, cleanupFailure=cleanup,
    )


def bounded_holder_log_detail(log):
    try:
        log.flush()
        with open(log.name, "rb") as reader:
            reader.seek(0, os.SEEK_END)
            size = reader.tell()
            reader.seek(max(0, size - 8192), os.SEEK_SET)
            content = reader.read(8192).decode("utf-8", errors="replace")
    except (AttributeError, OSError, ValueError):
        return "DETAIL_UNAVAILABLE"
    for line in reversed(content.splitlines()):
        line = line.strip()
        supervisor = re.search(r"SupervisorFailure:\s*([A-Z0-9_.:-]{1,160})$", line)
        if supervisor:
            return safe_failure(supervisor.group(1))
        invalid_mode = re.search(r"argument --mode: invalid choice: ['\"]([^'\"]+)['\"]", line)
        if invalid_mode:
            return "PYTHON_MODE_ARGUMENT_REJECTED_" + safe_failure(invalid_mode.group(1))
        if "Operation not permitted" in line:
            return "OPERATION_NOT_PERMITTED"
        if "Permission denied" in line:
            return "PERMISSION_DENIED"
        if "No such file or directory" in line:
            return "NO_SUCH_FILE_OR_DIRECTORY"
        if "ModuleNotFoundError:" in line or "ImportError:" in line:
            return "PYTHON_MODULE_IMPORT_FAILURE"
        if "SyntaxError:" in line:
            return "PYTHON_SYNTAX_ERROR"
        if "PermissionError:" in line:
            return "PERMISSION_ERROR"
        if line.startswith("unshare:"):
            return "UNSHARE_FAILED"
    return "DETAIL_UNAVAILABLE"


def fixture_event_failure(events, outer_ids, stream_state, *, holder_exit_status=None, holder_log=None, stream_failure=None):
    if not isinstance(events, list) or stream_state not in {"eof", "timeout", "invalid"}:
        return FixtureSetupFailure("HOLDER_LAUNCH_OR_SETUP_FAILURE", "FIXTURE_EVENT_READER_STATE_INVALID")
    if any(not isinstance(event, dict) for event in events):
        return FixtureSetupFailure("READY_EVENT_INVALID", "HOLDER_EVENT_SHAPE_INVALID")

    failures = [event for event in events if event.get("kind") == "failure"]
    if failures:
        event = failures[0]
        category = event.get("category")
        reason = event.get("reason", "UNKNOWN")
        cleanup = event.get("cleanupFailure")
        event_category = "HOLDER_EMITTED_FAILURE_EVENT"
        if isinstance(category, str) and category in {"NAMESPACE_SETUP_FAILURE", "CANCELLATION_STAGE_SETUP_FAILURE"}:
            event_category += ":" + category
        primary = event.get("primaryFailure")
        if primary in (None, "NONE"):
            primary = reason if cleanup in (None, "NONE") else None
        cleanup_error = cleanup if cleanup not in (None, "NONE") else None
        return FixtureSetupFailure(event_category, primary, cleanup_error)

    ready = [(index, event) for index, event in enumerate(events) if event.get("kind") == "ready"]
    barriers = [(index, event) for index, event in enumerate(events) if event.get("kind") == "barrier"]
    if not ready:
        detail = "READY_EVENT_MISSING"
        if stream_state == "invalid":
            detail += ":EVENT_STREAM_" + safe_failure(stream_failure or "INVALID_BEFORE_READY")
        if holder_exit_status is not None:
            detail += ":HOLDER_EXIT_STATUS_" + safe_failure(holder_exit_status)
        if holder_log is not None:
            detail += ":HOLDER_LOG_" + bounded_holder_log_detail(holder_log)
        if stream_state == "eof":
            return FixtureSetupFailure("EOF_BEFORE_REQUIRED_EVENTS", detail)
        if stream_state == "timeout":
            return FixtureSetupFailure("TIMEOUT_BEFORE_REQUIRED_EVENTS", detail)
        return FixtureSetupFailure("READY_EVENT_INVALID", detail)

    ready_event = ready[0][1]
    required_ready_fields = {"kind", "pid", "mountNamespace", "userNamespace", "pidNamespace"}
    if (
        len(ready) != 1
        or set(ready_event) != required_ready_fields
        or any(type(ready_event.get(key)) is not int or ready_event[key] <= 0 for key in ("pid", "mountNamespace", "userNamespace", "pidNamespace"))
        or ready_event.get("userNamespace") != outer_ids[0]["number"]
        or ready_event.get("pidNamespace") != outer_ids[1]["number"]
        or ready_event.get("mountNamespace") == outer_ids[2]["number"]
    ):
        return FixtureSetupFailure("READY_EVENT_INVALID", "FIXTURE_NAMESPACE_IDENTITY_INVALID")

    if not barriers:
        if stream_state == "eof":
            return FixtureSetupFailure("EOF_BEFORE_REQUIRED_EVENTS", "BARRIER_EVENT_MISSING")
        if stream_state == "timeout":
            return FixtureSetupFailure("TIMEOUT_BEFORE_REQUIRED_EVENTS", "BARRIER_EVENT_MISSING")
        detail = "EVENT_STREAM_" + safe_failure(stream_failure or "INVALID_AFTER_READY")
        return FixtureSetupFailure("BARRIER_EVENT_INVALID", detail)

    if (
        len(barriers) != 1
        or barriers[0][0] < ready[0][0]
        or not exact_barrier_event(barriers[0][1])
    ):
        return FixtureSetupFailure("BARRIER_EVENT_INVALID", "FIXTURE_HOLDER_BARRIER_SHAPE_OR_ORDER_INVALID")
    if stream_state == "invalid":
        detail = "EVENT_STREAM_" + safe_failure(stream_failure or "INVALID_AFTER_BARRIER")
        return FixtureSetupFailure("BARRIER_EVENT_INVALID", detail)
    if stream_state == "timeout":
        return FixtureSetupFailure("TIMEOUT_AFTER_REQUIRED_EVENTS", "FIXTURE_HOLDER_RESULT_STREAM_DID_NOT_CLOSE")
    return None


def exact_barrier_event(event):
    return (
        isinstance(event, dict)
        and set(event) == set(FIXTURE_BARRIER_EVENT)
        and all(type(event.get(key)) is bool for key in FIXTURE_BARRIER_EVENT if key != "kind")
        and event == FIXTURE_BARRIER_EVENT
    )


def holder_emitted_failure(events):
    failures = [event for event in events if isinstance(event, dict) and event.get("kind") == "failure"]
    if not failures:
        return None
    first = failures[0]
    category = "HOLDER_EMITTED_FAILURE_EVENT"
    event_category = first.get("category")
    if isinstance(event_category, str):
        category += ":" + safe_failure(event_category)
    primary = first.get("primaryFailure")
    first_cleanup = first.get("cleanupFailure")
    if primary is None:
        primary = first.get("reason", "UNKNOWN")
    elif primary == "NONE" and first_cleanup in (None, "NONE"):
        primary = first.get("reason", "UNKNOWN")
    elif primary == "NONE":
        primary = None
    cleanup = []
    if first_cleanup not in (None, "NONE"):
        cleanup.append(first_cleanup)
    for event in failures[1:]:
        cleanup_value = event.get("cleanupFailure")
        if cleanup_value not in (None, "NONE"):
            cleanup.append(cleanup_value)
        elif event.get("primaryFailure") in (None, "NONE"):
            cleanup.append(event.get("reason", "UNKNOWN"))
        else:
            cleanup.append(event.get("reason", event.get("primaryFailure", "UNKNOWN")))
    return FixtureSetupFailure(category, primary, combined_failure(cleanup))


def run_route_b_opt_controls(expect):
    def expect_failure(operation, reason, marker):
        try:
            operation()
        except SupervisorFailure as error:
            expect(str(error) == reason, marker)
        else:
            expect(False, marker)

    mount_row = {
        "mountId": "10", "parentId": "1", "device": "0:42", "root": "/",
        "mountpoint": "/", "parentMountpoint": "/", "mountOptions": ["rw"],
        "optional": ["shared:4"], "fstype": "ext4", "source": "/dev/root",
        "superOptions": ["rw", "errors=remount-ro"], "raw": "control",
    }
    private_mount_row = dict(mount_row, mountId="99", parentId="77", optional=["master:12"])
    expect(
        normalize_opt_mount_view([mount_row]) == normalize_opt_mount_view([private_mount_row]),
        "ROUTE_B_OPT_CONTROL_PROPAGATION_NORMALIZED",
    )
    outer = {
        "fileType": "directory",
        "identity": {
            "device": 42, "inode": 100, "uid": 0, "gid": 0, "mode": 0o777,
            "size": 4096, "mtimeNs": 11, "ctimeNs": 12,
        },
        "accessAcl": None, "defaultAcl": None, "children": [],
        "mountView": normalize_opt_mount_view([mount_row]), "mounts": ("control",),
    }
    receipt = parse_outer_opt_reference(serialize_outer_opt_reference(outer))
    expect(validate_outer_opt_snapshot(receipt, outer), "ROUTE_B_OPT_CONTROL_OUTER_0777_ACCEPTED")
    expect_failure(
        lambda: parse_outer_opt_reference('{"schema":"x","schema":"y"}'),
        "OUTER_OPT_REFERENCE_INVALID",
        "ROUTE_B_OPT_CONTROL_DUPLICATE_RECEIPT_KEY_REJECTED",
    )

    changed_cases = (
        ("device", 43, "OUTER_OPT_DEVICE_CHANGED", "ROUTE_B_OPT_CONTROL_OUTER_DEVICE_DRIFT"),
        ("inode", 101, "OUTER_OPT_INODE_CHANGED", "ROUTE_B_OPT_CONTROL_OUTER_INODE_DRIFT"),
        ("uid", 1, "OUTER_OPT_UID_CHANGED", "ROUTE_B_OPT_CONTROL_OUTER_UID_DRIFT"),
        ("gid", 1, "OUTER_OPT_GID_CHANGED", "ROUTE_B_OPT_CONTROL_OUTER_GID_DRIFT"),
        ("mode", 0o755, "OUTER_OPT_MODE_CHANGED", "ROUTE_B_OPT_CONTROL_OUTER_MODE_DRIFT"),
    )
    for field, value, reason, marker in changed_cases:
        changed = json.loads(json.dumps(outer))
        changed["identity"][field] = value
        expect_failure(lambda changed=changed: validate_outer_opt_snapshot(receipt, changed), reason, marker)
    for field, value, reason, marker in (
        ("accessAcl", "010203", "OUTER_OPT_ACCESS_ACL_CHANGED", "ROUTE_B_OPT_CONTROL_OUTER_ACCESS_ACL_DRIFT"),
        ("defaultAcl", "040506", "OUTER_OPT_DEFAULT_ACL_CHANGED", "ROUTE_B_OPT_CONTROL_OUTER_DEFAULT_ACL_DRIFT"),
    ):
        changed = json.loads(json.dumps(outer))
        changed[field] = value
        expect_failure(lambda changed=changed: validate_outer_opt_snapshot(receipt, changed), reason, marker)
    changed_mount = json.loads(json.dumps(outer))
    changed_mount["mountView"][0]["mountOptions"] = ["ro"]
    expect_failure(
        lambda: validate_outer_opt_snapshot(receipt, changed_mount),
        "OUTER_OPT_MOUNT_VIEW_CHANGED",
        "ROUTE_B_OPT_CONTROL_OUTER_MOUNT_VIEW_DRIFT",
    )
    changed_children = json.loads(json.dumps(outer))
    changed_children["children"] = [{"name": "changed"}]
    expect_failure(
        lambda: validate_outer_opt_snapshot(receipt, changed_children),
        "OUTER_OPT_CHILDREN_CHANGED",
        "ROUTE_B_OPT_CONTROL_OUTER_CHILD_DRIFT",
    )
    expect_failure(
        lambda: validate_outer_opt_path_mode(stat.S_IFLNK | 0o777),
        "OUTER_OPT_SYMLINK",
        "ROUTE_B_OPT_CONTROL_OUTER_SYMLINK_REJECTED",
    )
    expect_failure(
        lambda: validate_outer_opt_path_mode(stat.S_IFREG | 0o755),
        "OUTER_OPT_NOT_DIRECTORY",
        "ROUTE_B_OPT_CONTROL_OUTER_NON_DIRECTORY_REJECTED",
    )

    inner_identity = {"fileType": "directory", "device": 77, "uid": 0, "gid": 0, "mode": 0o755}
    inner_rows = [{
        "fstype": "tmpfs", "source": "tmpfs", "mountOptions": ["rw"],
        "superOptions": ["rw", "nosuid", "nodev", "mode=755", "size=4G"],
    }]
    expect(
        validate_inner_opt_mount(inner_identity, outer["identity"]["device"], inner_rows, None),
        "ROUTE_B_OPT_CONTROL_INNER_DISTINCT_TMPFS_ACCEPTED",
    )
    for field, value, reason, marker in (
        ("uid", 1, "ROUTE_B_OPT_OWNER_INVALID", "ROUTE_B_OPT_CONTROL_INNER_UID_REJECTED"),
        ("gid", 1, "ROUTE_B_OPT_OWNER_INVALID", "ROUTE_B_OPT_CONTROL_INNER_GID_REJECTED"),
        ("mode", 0o777, "ROUTE_B_OPT_MODE_INVALID", "ROUTE_B_OPT_CONTROL_INNER_MODE_REJECTED"),
    ):
        changed = dict(inner_identity, **{field: value})
        expect_failure(
            lambda changed=changed: validate_inner_opt_mount(changed, outer["identity"]["device"], inner_rows, None),
            reason,
            marker,
        )
    expect_failure(
        lambda: validate_inner_opt_mount(dict(inner_identity, device=outer["identity"]["device"]), outer["identity"]["device"], inner_rows, None),
        "ROUTE_B_OPT_FILESYSTEM_NOT_DISTINCT",
        "ROUTE_B_OPT_CONTROL_INNER_SAME_DEVICE_REJECTED",
    )
    bad_filesystem = [dict(inner_rows[0], fstype="ext4")]
    expect_failure(
        lambda: validate_inner_opt_mount(inner_identity, outer["identity"]["device"], bad_filesystem, None),
        "ROUTE_B_OPT_MOUNT_IDENTITY_INVALID",
        "ROUTE_B_OPT_CONTROL_INNER_FILESYSTEM_REJECTED",
    )
    expect_failure(
        lambda: validate_inner_opt_mount(inner_identity, outer["identity"]["device"], inner_rows, "010203"),
        "ROUTE_B_OPT_DEFAULT_ACL_INVALID",
        "ROUTE_B_OPT_CONTROL_INNER_DEFAULT_ACL_REJECTED",
    )


def run_product_leaf_lifecycle_controls(expect):
    def expect_failure(operation, reason, marker):
        try:
            operation()
        except SupervisorFailure as error:
            expect(str(error) == reason, marker)
        else:
            expect(False, marker)

    with tempfile.TemporaryDirectory(prefix="s8-product-leaf-control-") as temp_dir:
        inner_root = Path(temp_dir) / "opt"
        inner_root.mkdir(mode=0o755)
        os.chmod(inner_root, 0o755)
        inner_identity = route_b_path_identity(inner_root)
        inner_identity["defaultAcl"] = None
        expect(
            validate_product_leaves_absent(inner_root, inner_identity, mounted_paths=set()),
            "HOSTED_PRODUCT_LEAF_CONTROL_EMPTY_INNER_OPT_ACCEPTED",
        )

        for name, marker in (
            ("blender", "HOSTED_PRODUCT_LEAF_CONTROL_BLENDER_PREEXISTING_DIRECTORY_REJECTED"),
            ("swooshz", "HOSTED_PRODUCT_LEAF_CONTROL_SWOOSHZ_PREEXISTING_DIRECTORY_REJECTED"),
        ):
            path = inner_root / name
            path.mkdir(mode=0o755)
            expect_failure(
                lambda path=path: validate_product_leaves_absent(inner_root, inner_identity, mounted_paths=set()),
                "HOSTED_PRODUCT_LEAF_NOT_FRESH:" + str(path),
                marker,
            )
            path.rmdir()

        for name, file_type, marker in (
            ("blender", "file", "HOSTED_PRODUCT_LEAF_CONTROL_FILE_REJECTED"),
            ("blender", "symlink", "HOSTED_PRODUCT_LEAF_CONTROL_SYMLINK_REJECTED"),
            ("swooshz", "symlink", "HOSTED_PRODUCT_LEAF_CONTROL_BROKEN_SYMLINK_REJECTED"),
            ("swooshz", "fifo", "HOSTED_PRODUCT_LEAF_CONTROL_SPECIAL_OBJECT_REJECTED"),
            ("swooshz", "other", "HOSTED_PRODUCT_LEAF_CONTROL_OTHER_OBJECT_REJECTED"),
        ):
            path = inner_root / name
            expect_failure(
                lambda path=path, file_type=file_type: validate_product_leaf_absence_state(path, file_type, False),
                "HOSTED_PRODUCT_LEAF_NOT_FRESH:" + str(path),
                marker,
            )

        mounted_leaf = inner_root / "blender"
        expect_failure(
            lambda: validate_product_leaves_absent(inner_root, inner_identity, mounted_paths={str(mounted_leaf)}),
            "HOSTED_PRODUCT_LEAF_NOT_FRESH:" + str(mounted_leaf),
            "HOSTED_PRODUCT_LEAF_CONTROL_MOUNTPOINT_REJECTED",
        )

        for name, marker in (
            ("blender", "ROUTE_B_PRODUCT_LEAF_CONTROL_DEPLOYED_BLENDER_ACCEPTED"),
            ("swooshz", "ROUTE_B_PRODUCT_LEAF_CONTROL_DEPLOYED_SWOOSHZ_ACCEPTED"),
        ):
            path = inner_root / name
            deployed_identity = {
                "fileType": "directory", "device": inner_identity["device"], "inode": 10,
                "uid": 0, "gid": 0, "mode": 0o755,
            }
            expect(
                validate_product_leaf_identity(path, inner_root, inner_identity, deployed_identity, None),
                marker,
            )
        for field, value, reason, marker in (
            ("fileType", "symlink", "ROUTE_B_PRODUCT_LEAF_TYPE_INVALID", "ROUTE_B_PRODUCT_LEAF_CONTROL_SYMLINK_DEPLOYMENT_REJECTED"),
            ("device", inner_identity["device"] + 1, "ROUTE_B_PRODUCT_LEAF_DEVICE_INVALID", "ROUTE_B_PRODUCT_LEAF_CONTROL_WRONG_DEVICE_REJECTED"),
            ("uid", 1, "ROUTE_B_PRODUCT_LEAF_OWNER_INVALID", "ROUTE_B_PRODUCT_LEAF_CONTROL_WRONG_UID_REJECTED"),
            ("gid", 1, "ROUTE_B_PRODUCT_LEAF_OWNER_INVALID", "ROUTE_B_PRODUCT_LEAF_CONTROL_WRONG_GID_REJECTED"),
            ("mode", 0o775, "ROUTE_B_PRODUCT_LEAF_MODE_INVALID", "ROUTE_B_PRODUCT_LEAF_CONTROL_WRONG_MODE_REJECTED"),
        ):
            changed = dict(deployed_identity, **{field: value})
            expect_failure(
                lambda changed=changed: validate_product_leaf_identity(inner_root / "blender", inner_root, inner_identity, changed, None),
                reason,
                marker,
            )
        expect_failure(
            lambda: validate_product_leaf_identity(inner_root / "blender", inner_root, inner_identity, deployed_identity, "010203"),
            "ROUTE_B_PRODUCT_LEAF_DEFAULT_ACL_INVALID",
            "ROUTE_B_PRODUCT_LEAF_CONTROL_DEFAULT_ACL_REJECTED",
        )
        expect_failure(
            lambda: validate_product_leaf_identity(inner_root / "other", inner_root, inner_identity, deployed_identity, None),
            "ROUTE_B_PRODUCT_LEAF_PATH_INVALID",
            "ROUTE_B_PRODUCT_LEAF_CONTROL_NONFIXED_PATH_REJECTED",
        )


def run_toolchain_preservation_controls(expect):
    def expect_failure(operation, reason, marker):
        try:
            operation()
        except SupervisorFailure as error:
            expect(str(error) == reason, marker)
        else:
            expect(False, marker)

    installation = "/opt/hostedtoolcache/node/22.16.0/x64"
    node = {
        "requested": installation + "/bin/node", "resolved": installation + "/bin/node",
        "device": 2049, "inode": 11, "mode": 0o755, "size": 1024, "sha256": "a" * 64,
    }
    corepack = {
        "requested": installation + "/bin/corepack", "resolved": installation + "/bin/corepack",
        "device": 2049, "inode": 12, "mode": 0o755, "size": 512, "sha256": "b" * 64,
    }
    plan = derive_toolchain_plan(node, corepack)
    expect(plan["source"] == installation + "/bin" and plan["destination"] == plan["source"], "HOSTED_TOOLCHAIN_CONTROL_MINIMAL_SUBTREE_SELECTED")
    source_identity = {"path": plan["source"], "device": 2049, "inode": 20, "uid": 0, "gid": 0, "mode": 0o755}
    target_identity = dict(source_identity, path="/tmp/s8-stage/tree")
    target_plan = dict(plan, destination=target_identity["path"])
    mount = {
        "mountId": "41", "mountpoint": target_identity["path"],
        "device": f"{os.major(2049)}:{os.minor(2049)}", "mountOptions": ["ro", "nosuid", "nodev", "relatime"],
    }
    expect(validate_toolchain_bind(target_plan, source_identity, target_identity, [mount]), "HOSTED_TOOLCHAIN_CONTROL_READONLY_EXECUTABLE_BIND_ACCEPTED")
    expect(
        source_identity["path"] != target_identity["path"]
        and validate_toolchain_bind(target_plan, source_identity, target_identity, [mount]),
        "HOSTED_TOOLCHAIN_CONTROL_DIFFERENT_SOURCE_STAGE_PATHS_ACCEPTED",
    )
    expect(
        validate_toolchain_staging_identity(target_identity["path"], target_identity, dict(target_identity)),
        "HOSTED_TOOLCHAIN_CONTROL_STAGING_IDENTITY_CONTINUITY_ACCEPTED",
    )
    for field, marker in (
        ("device", "HOSTED_TOOLCHAIN_CONTROL_STAGING_DEVICE_CHANGE_REJECTED"),
        ("inode", "HOSTED_TOOLCHAIN_CONTROL_STAGING_INODE_CHANGE_REJECTED"),
        ("uid", "HOSTED_TOOLCHAIN_CONTROL_STAGING_UID_CHANGE_REJECTED"),
        ("gid", "HOSTED_TOOLCHAIN_CONTROL_STAGING_GID_CHANGE_REJECTED"),
        ("mode", "HOSTED_TOOLCHAIN_CONTROL_STAGING_MODE_CHANGE_REJECTED"),
    ):
        changed_post_mount_identity = dict(target_identity, **{field: target_identity[field] ^ 1})
        expect_failure(
            lambda: validate_toolchain_staging_identity(target_identity["path"], target_identity, changed_post_mount_identity),
            "HOSTED_TOOLCHAIN_STAGING_IDENTITY_CHANGED",
            marker,
        )
    expect_failure(
        lambda: validate_toolchain_staging_identity(source_identity["path"], target_identity, target_identity),
        "HOSTED_TOOLCHAIN_STAGING_PATH_INVALID",
        "HOSTED_TOOLCHAIN_CONTROL_WRONG_STAGING_PATH_REJECTED",
    )
    wrong_stage_role = dict(target_identity, path=source_identity["path"])
    expect_failure(
        lambda: validate_toolchain_staging_identity(target_identity["path"], target_identity, wrong_stage_role),
        "HOSTED_TOOLCHAIN_STAGING_PATH_INVALID",
        "HOSTED_TOOLCHAIN_CONTROL_WRONG_STAGING_ROLE_REJECTED",
    )
    expect_failure(
        lambda: derive_toolchain_plan(node, corepack, source="/opt/hostedtoolcache"),
        "HOSTED_TOOLCHAIN_SOURCE_NOT_MINIMAL",
        "HOSTED_TOOLCHAIN_CONTROL_WRONG_SOURCE_SUBTREE_REJECTED",
    )
    expect_failure(
        lambda: derive_toolchain_plan(node, corepack, source="/opt"),
        "HOSTED_TOOLCHAIN_SOURCE_NOT_MINIMAL",
        "HOSTED_TOOLCHAIN_CONTROL_BROAD_OPT_BIND_REJECTED",
    )
    unrelated = dict(corepack, resolved="/opt/hostedtoolcache/pnpm/9.0.0/x64/bin/corepack")
    expect_failure(
        lambda: derive_toolchain_plan(node, unrelated),
        "HOSTED_TOOLCHAIN_SOURCE_OUTSIDE_NODE_TOOLCACHE",
        "HOSTED_TOOLCHAIN_CONTROL_UNRELATED_TOOLCACHE_REJECTED",
    )
    expect_failure(
        lambda: derive_toolchain_plan(node, corepack, destination="/opt/hostedtoolcache/node/22.16.0/x64/lib"),
        "HOSTED_TOOLCHAIN_DESTINATION_INVALID",
        "HOSTED_TOOLCHAIN_CONTROL_WRONG_DESTINATION_REJECTED",
    )
    changed_target = dict(target_identity, inode=21)
    expect_failure(
        lambda: validate_toolchain_bind(target_plan, source_identity, changed_target, [mount]),
        "HOSTED_TOOLCHAIN_BIND_IDENTITY_MISMATCH",
        "HOSTED_TOOLCHAIN_CONTROL_SOURCE_IDENTITY_CHANGE_REJECTED",
    )
    changed_source = dict(source_identity, inode=21)
    expect_failure(
        lambda: validate_toolchain_bind(target_plan, changed_source, target_identity, [mount]),
        "HOSTED_TOOLCHAIN_BIND_IDENTITY_MISMATCH",
        "HOSTED_TOOLCHAIN_CONTROL_WRONG_ORIGINAL_SOURCE_OBJECT_REJECTED",
    )
    changed_node = dict(node, sha256="c" * 64)
    expect_failure(
        lambda: validate_toolchain_identity(node, changed_node),
        "HOSTED_TOOLCHAIN_IDENTITY_CHANGED",
        "HOSTED_TOOLCHAIN_CONTROL_SOURCE_HASH_CHANGE_REJECTED",
    )
    wrong_destination = dict(mount, mountpoint="/tmp/wrong-destination")
    expect_failure(
        lambda: validate_toolchain_bind(target_plan, source_identity, target_identity, [wrong_destination], destination="/tmp/wrong-destination"),
        "HOSTED_TOOLCHAIN_BIND_DESTINATION_INVALID",
        "HOSTED_TOOLCHAIN_CONTROL_WRONG_MOUNT_DESTINATION_REJECTED",
    )
    writable_mount = dict(mount, mountOptions=["rw", "nosuid", "nodev"])
    expect_failure(
        lambda: validate_toolchain_bind(target_plan, source_identity, target_identity, [writable_mount]),
        "HOSTED_TOOLCHAIN_BIND_FLAGS_INVALID",
        "HOSTED_TOOLCHAIN_CONTROL_WRITABLE_BIND_REJECTED",
    )
    expect_failure(
        lambda: validate_unpreserved_toolchain_missing(True, False),
        "HOSTED_TOOLCHAIN_NO_PRESERVATION_NEGATIVE_FALSE_GREEN",
        "HOSTED_TOOLCHAIN_CONTROL_NO_BIND_MISSING_FAILURE_REQUIRED",
    )
    expect_failure(
        lambda: validate_toolchain_namespace_release(False),
        "HOSTED_TOOLCHAIN_NAMESPACE_REFERENCE_REMAINS",
        "HOSTED_TOOLCHAIN_CONTROL_RETAINED_NAMESPACE_REFERENCE_BLOCKS_TEARDOWN",
    )


def validate_fixture_diagnostic_controls():
    outer_ids = ({"number": 101}, {"number": 202}, {"number": 303})
    ready = {"kind": "ready", "pid": 404, "mountNamespace": 505, "userNamespace": 101, "pidNamespace": 202}
    barrier = dict(FIXTURE_BARRIER_EVENT)

    def expect(condition, marker):
        if not condition:
            raise SupervisorFailure("FIXTURE_DIAGNOSTIC_CONTROL_FAILED:" + marker)
        emit_to_stdout(marker + "=PASS\n")

    run_route_b_opt_controls(expect)
    run_product_leaf_lifecycle_controls(expect)
    run_toolchain_preservation_controls(expect)

    def fail_before_launch():
        raise SupervisorFailure("UNSHARE_LAUNCH_FAILED")

    try:
        launch_fixture_holder(fail_before_launch)
    except FixtureSetupFailure as launch_error:
        expect(str(launch_error).startswith("HOLDER_LAUNCH_OR_SETUP_FAILURE:"), "FIXTURE_DIAGNOSTIC_LAUNCH_SETUP")
    else:
        raise SupervisorFailure("FIXTURE_DIAGNOSTIC_CONTROL_FAILED:FIXTURE_DIAGNOSTIC_LAUNCH_SETUP")
    eof_before_ready = fixture_event_failure([], outer_ids, "eof")
    expect(str(eof_before_ready).startswith("EOF_BEFORE_REQUIRED_EVENTS:READY_EVENT_MISSING"), "FIXTURE_DIAGNOSTIC_EOF_BEFORE_READY")
    timeout_before_ready = fixture_event_failure([], outer_ids, "timeout")
    expect(str(timeout_before_ready).startswith("TIMEOUT_BEFORE_REQUIRED_EVENTS:READY_EVENT_MISSING"), "FIXTURE_DIAGNOSTIC_TIMEOUT_BEFORE_READY")
    parser_arguments = [
        "--holder", "--workspace", "/workspace", "--carrier", "/carrier", "--temp-root", "/tmp",
        "--uid", "1000", "--gid", "1000", "--node", "/usr/bin/python3", "--corepack", "/usr/bin/python3",
        "--toolchain-stage-root", "/tmp/toolchain-stage-control",
    ]
    for mode_name, marker in zip(FIXTURE_CANCEL_MODES, ("FIXTURE_DIAGNOSTIC_CANCEL_OPT_MODE_ACCEPTED", "FIXTURE_DIAGNOSTIC_CANCEL_APPLICATION_MODE_ACCEPTED")):
        parsed = build_argument_parser().parse_args(parser_arguments + ["--mode", mode_name])
        expect(parsed.holder and parsed.mode == mode_name, marker)
    invalid_stream_before_ready = fixture_event_failure(
        [], outer_ids, "invalid", stream_failure=SupervisorFailure("NAMESPACE_HOLDER_EVENT_INVALID"),
    )
    expect(str(invalid_stream_before_ready).endswith("EVENT_STREAM_NAMESPACE_HOLDER_EVENT_INVALID"), "FIXTURE_DIAGNOSTIC_INVALID_STREAM_REASON")
    with tempfile.TemporaryDirectory(prefix="s8-fixture-diagnostic-control-") as temp_dir:
        log_path = Path(temp_dir) / "holder.log"
        log_path.write_bytes(b"x" * 10000 + b"\nSupervisorFailure: NAMESPACE_SETUP_FAILED\n")

        class LogReference:
            name = str(log_path)

            def flush(self):
                return None

        expect(bounded_holder_log_detail(LogReference()) == "NAMESPACE_SETUP_FAILED", "FIXTURE_DIAGNOSTIC_BOUNDED_LOG_REASON")
        timeout_with_live_holder_log = fixture_event_failure([], outer_ids, "timeout", holder_log=LogReference())
        expect(str(timeout_with_live_holder_log).endswith("HOLDER_LOG_NAMESPACE_SETUP_FAILED"), "FIXTURE_DIAGNOSTIC_TIMEOUT_LOG_REASON")
        log_path.write_bytes(b"error: argument --mode: invalid choice: 'fixture-opt-cancel'\n")
        expect(bounded_holder_log_detail(LogReference()) == "PYTHON_MODE_ARGUMENT_REJECTED_FIXTURE-OPT-CANCEL", "FIXTURE_DIAGNOSTIC_ARGUMENT_PARSE_REASON")
        log_path.write_bytes(b"ModuleNotFoundError: No module named 'pwd'\n")
        expect(bounded_holder_log_detail(LogReference()) == "PYTHON_MODULE_IMPORT_FAILURE", "FIXTURE_DIAGNOSTIC_STARTUP_IMPORT_FAILURE")
    namespace_failure = fixture_event_failure(
        [{"kind": "failure", "category": "NAMESPACE_SETUP_FAILURE", "reason": "MOUNT_SETUP_FAILED", "primaryFailure": "MOUNT_SETUP_FAILED", "cleanupFailure": "NONE"}],
        outer_ids, "eof",
    )
    expect("HOLDER_EMITTED_FAILURE_EVENT:NAMESPACE_SETUP_FAILURE" in str(namespace_failure), "FIXTURE_DIAGNOSTIC_NAMESPACE_SETUP_FAILURE")
    cancellation_failure = fixture_event_failure(
        [{"kind": "failure", "category": "CANCELLATION_STAGE_SETUP_FAILURE", "reason": "WORKLOAD_SETUP_FAILED", "primaryFailure": "WORKLOAD_SETUP_FAILED", "cleanupFailure": "NONE"}],
        outer_ids, "eof",
    )
    expect("HOLDER_EMITTED_FAILURE_EVENT:CANCELLATION_STAGE_SETUP_FAILURE" in str(cancellation_failure), "FIXTURE_DIAGNOSTIC_CANCELLATION_SETUP_FAILURE")
    no_barrier = fixture_event_failure([ready], outer_ids, "eof")
    expect(str(no_barrier).startswith("EOF_BEFORE_REQUIRED_EVENTS:BARRIER_EVENT_MISSING"), "FIXTURE_DIAGNOSTIC_READY_WITHOUT_BARRIER")
    malformed_barrier = dict(barrier, holderReaped=0)
    invalid_barrier = fixture_event_failure([ready, malformed_barrier], outer_ids, "eof")
    expect(str(invalid_barrier).startswith("BARRIER_EVENT_INVALID:"), "FIXTURE_DIAGNOSTIC_MALFORMED_BARRIER")
    invalid_ready = dict(ready, userNamespace=999)
    expect(str(fixture_event_failure([invalid_ready, barrier], outer_ids, "eof")).startswith("READY_EVENT_INVALID:"), "FIXTURE_DIAGNOSTIC_INVALID_READY")
    emitted_failure = fixture_event_failure(
        [{"kind": "failure", "category": "CANCELLATION_STAGE_SETUP_FAILURE", "reason": "SETUP_FAILED", "primaryFailure": "SETUP_FAILED", "cleanupFailure": "CLEANUP_FAILED"}, ready],
        outer_ids, "eof",
    )
    expect("HOLDER_EMITTED_FAILURE_EVENT" in str(emitted_failure), "FIXTURE_DIAGNOSTIC_FAILURE_BEFORE_BARRIER")
    expect(fixture_event_failure([ready, barrier], outer_ids, "eof") is None, "FIXTURE_DIAGNOSTIC_EXACT_BARRIER_ACCEPTED")
    primary, cleanup = failure_pair_labels(SupervisorFailure("ORIGINAL_FIXTURE_FAILURE"), SupervisorFailure("CLEANUP_FAILED"))
    expect(primary == "ORIGINAL_FIXTURE_FAILURE" and cleanup == "CLEANUP_FAILED", "FIXTURE_DIAGNOSTIC_PRIMARY_PRESERVED")
    original = SupervisorFailure("ORIGINAL_FIXTURE_FAILURE")
    expect(effective_failure(original, SupervisorFailure("CLEANUP_FAILED")) is original, "FIXTURE_DIAGNOSTIC_CLEANUP_SECONDARY")
    cleanup_only = holder_emitted_failure([
        {"kind": "failure", "category": "HOLDER_CLEANUP_FAILURE", "reason": "CLEANUP_FAILED", "primaryFailure": "NONE", "cleanupFailure": "CLEANUP_FAILED"},
    ])
    primary, cleanup = failure_pair_labels(cleanup_only)
    expect(primary == "NONE" and cleanup == "CLEANUP_FAILED", "FIXTURE_DIAGNOSTIC_CLEANUP_NOT_PROMOTED")


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
            if not isinstance(event, dict) or not isinstance(event.get("kind"), str):
                raise SupervisorFailure("NAMESPACE_HOLDER_EVENT_INVALID")
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


def launch_holder(mode, *, workspace, carrier, temp_root, uid, gid, node, corepack, ledger_path, outer_ids, outer_opt):
    control_read = control_write = result_read = result_write = None
    log = None
    owned = None
    stage_root = None
    try:
        stage_root = create_toolchain_stage_root(temp_root)
        control_read, control_write = make_pipe()
        result_read, result_write = make_pipe()
        args = [
            "/usr/bin/unshare", "--mount", "--", sys.executable, str(Path(__file__).resolve()),
            "--holder", "--mode", mode, "--workspace", str(workspace), "--carrier", str(carrier),
            "--temp-root", str(temp_root), "--uid", str(uid), "--gid", str(gid), "--node", str(node),
            "--corepack", str(corepack), "--control-fd", str(control_read), "--result-fd", str(result_write),
            "--toolchain-stage-root", str(stage_root),
            "--ledger", str(ledger_path), "--outer-user-ns", str(outer_ids[0]["number"]),
            "--outer-pid-ns", str(outer_ids[1]["number"]), "--supervisor-pid", str(os.getpid()),
            "--outer-opt-reference", serialize_outer_opt_reference(outer_opt),
        ]
        minimal_env = {"PATH": "/usr/local/bin:/usr/bin:/bin", "LC_ALL": "C", "PYTHONUTF8": "1", "PYTHONUNBUFFERED": "1"}
        log = open(Path(temp_root) / ".namespace-state" / ("holder-" + mode + ".log"), "wb", buffering=0)
        owned = launch_owned(args, owner=f"root-supervisor:{os.getpid()}:{mode}-holder", ledger_path=ledger_path, cwd=workspace, env=minimal_env, stdout=log, pass_fds=(control_read, result_write))
        os.close(control_read)
        control_read = None
        os.close(result_write)
        result_write = None
        os.set_inheritable(control_write, False)
        return owned, control_write, result_read, log, stage_root
    except Exception as primary_failure:
        cleanup_failure = getattr(primary_failure, "cleanup_failure", None)
        if owned is not None and owned.terminal is None:
            try:
                terminate_owned(owned)
            except Exception as error:
                cleanup_failure = append_cleanup_failure(cleanup_failure, error)
        if stage_root is not None:
            try:
                namespace_closed = owned is None or (
                    owned.process.poll() is not None and namespace_disappeared(owned.mount_id, NAMESPACE_VERIFY_SECONDS)
                )
                validate_toolchain_namespace_release(namespace_closed)
                cleanup_toolchain_stage_root(temp_root, stage_root, namespace_closed=namespace_closed)
            except Exception as error:
                cleanup_failure = append_cleanup_failure(cleanup_failure, error)
        for descriptor in (control_read, result_write, control_write, result_read):
            if descriptor is not None:
                try:
                    os.close(descriptor)
                except OSError as error:
                    cleanup_failure = append_cleanup_failure(cleanup_failure, error)
        if log is not None:
            try:
                log.close()
            except OSError as error:
                cleanup_failure = append_cleanup_failure(cleanup_failure, error)
        failure = holder_launch_failure(primary_failure, cleanup_failure)
        if stage_root is not None and stage_root.exists():
            failure.toolchain_stage_root = stage_root
        if owned is not None:
            failure.toolchain_mount_namespace = owned.mount_id
        raise failure from primary_failure


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


def run_fixture(kind, *, workspace, temp_root, ledger_path, outer_ids, outer_opt, uid, gid, node, corepack, retained_reference=False):
    modes = {
        "leaked-holder": ("fixture", None),
        "positive-release": ("fixture", None),
        "cancel-opt": (FIXTURE_CANCEL_MODES[0], "OPT_MOUNTED"),
        "cancel-application": (FIXTURE_CANCEL_MODES[1], "APPLICATION_RUNNING"),
    }
    if kind not in modes:
        raise SupervisorFailure("LIFECYCLE_FIXTURE_KIND_INVALID")
    mode, cancel_stage = modes[kind]
    try:
        owned, control_write, result_read, log, stage_root = launch_fixture_holder(
            launch_holder,
            mode, workspace=workspace, carrier="/", temp_root=temp_root, uid=uid, gid=gid,
            node=node if cancel_stage is not None else "/usr/bin/python3",
            corepack=corepack if cancel_stage is not None else "/usr/bin/python3",
            ledger_path=ledger_path, outer_ids=outer_ids, outer_opt=outer_opt,
        )
        namespace_number = owned.mount_id
    except Exception as error:
        failure = error if isinstance(error, FixtureSetupFailure) else holder_launch_failure(error)
        emit_to_stdout("FIXTURE_DIAGNOSTIC=" + safe_failure(failure.category) + "\n")
        raise failure
    holder_nsfd = None
    namespace_number = None
    events = []
    control_closed = False
    stage_cleanup_attempted = False
    primary_failure = None
    cleanup_errors = []

    def collect(event):
        events.append(event)
        if cancel_stage is not None and event.get("kind") == "stage" and event.get("name") == cancel_stage:
            try:
                os.write(control_write, b"C")
            except OSError as error:
                raise FixtureSetupFailure("CANCELLATION_STAGE_SETUP_FAILURE", error) from error

    try:
        stream_state = "eof"
        try:
            read_events_and_eof(result_read, 20, collect)
        except Exception as error:
            if isinstance(error, FixtureSetupFailure):
                raise
            stream_state = "timeout" if str(error) == "NAMESPACE_HOLDER_RESULT_TIMEOUT" else "invalid"
            failure = fixture_event_failure(
                events, outer_ids, stream_state,
                holder_exit_status=owned.process.poll(), holder_log=log, stream_failure=error,
            )
            if failure is None:
                failure = FixtureSetupFailure("READY_EVENT_INVALID", safe_failure(error))
            raise failure from error
        failure = fixture_event_failure(
            events, outer_ids, stream_state,
            holder_exit_status=owned.process.poll(), holder_log=log,
        )
        if failure is not None:
            raise failure
        ready = [event for event in events if event.get("kind") == "ready"]
        ready_event = ready[0]
        namespace_number = ready_event["mountNamespace"]
        if (
            ready_event.get("pid") != owned.pid
            or not owned.identity_valid()
            or namespace_identity(owned.pid, "mnt")["number"] != namespace_number
        ):
            raise SupervisorFailure("FIXTURE_HOLDER_IDENTITY_CHANGED")
        owned.mount_id = namespace_number
        if cancel_stage is not None:
            validate_toolchain_preservation_events(events, namespace_number, stage_root)
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
        stage_cleanup_attempted = True
        cleanup_toolchain_stage_root(temp_root, stage_root, namespace_closed=True)
        emit_to_stdout("HOSTED_TOOLCHAIN_NAMESPACE_RESOURCE_RELEASE=PASS\n")
        if kind == "positive-release":
            emit_to_stdout("POSITIVE_HOLDER_RELEASE_REAP=PASS\nNAMESPACE_REFERENCE_CLOSURE=PASS\n")
        elif kind == "cancel-opt":
            emit_to_stdout("CANCELLATION_AFTER_OPT_MOUNT=PASS\n")
        elif kind == "cancel-application":
            emit_to_stdout("CANCELLATION_DURING_APPLICATION=PASS\n")
    except Exception as error:
        primary_failure = error

    if primary_failure is not None:
        if owned.process.poll() is None:
            if not control_closed:
                try:
                    os.write(control_write, b"CR")
                except OSError:
                    pass
            try:
                drain_until_eof(result_read, BROKER_TEARDOWN_SECONDS + ROOT_CLEANUP_SECONDS)
            except Exception as error:
                cleanup_errors.append(error)
            if owned.process.poll() is None:
                try:
                    terminate_owned(owned)
                except Exception as error:
                    cleanup_errors.append(error)
        if owned.terminal is None and owned.process.poll() is not None:
            try:
                owned.wait(0)
            except Exception as error:
                cleanup_errors.append(error)
        if holder_nsfd is not None:
            try:
                os.close(holder_nsfd)
            except OSError as error:
                cleanup_errors.append(error)
            holder_nsfd = None
        if namespace_number is not None:
            try:
                if not namespace_disappeared(namespace_number, NAMESPACE_VERIFY_SECONDS):
                    cleanup_errors.append(SupervisorFailure("FIXTURE_NAMESPACE_REFERENCE_REMAINS_AFTER_FAILURE"))
            except Exception as error:
                cleanup_errors.append(error)

    if not stage_cleanup_attempted:
        try:
            namespace_closed = namespace_number is not None and namespace_disappeared(namespace_number, NAMESPACE_VERIFY_SECONDS)
            validate_toolchain_namespace_release(namespace_closed)
            stage_cleanup_attempted = True
            cleanup_toolchain_stage_root(temp_root, stage_root, namespace_closed=namespace_closed)
            emit_to_stdout("HOSTED_TOOLCHAIN_NAMESPACE_RESOURCE_RELEASE=PASS\n")
        except Exception as error:
            cleanup_errors.append(error)

    if not control_closed:
        try:
            os.close(control_write)
        except OSError as error:
            cleanup_errors.append(error)
    try:
        os.close(result_read)
    except OSError as error:
        cleanup_errors.append(error)
    try:
        log.close()
    except OSError as error:
        cleanup_errors.append(error)

    cleanup_failure = combined_failure(cleanup_errors)
    if primary_failure is not None:
        if cleanup_failure is not None:
            try:
                primary_failure.supervisor_cleanup_failure = cleanup_failure
            except Exception:
                pass
        if isinstance(primary_failure, FixtureSetupFailure):
            emit_to_stdout("FIXTURE_DIAGNOSTIC=" + safe_failure(primary_failure.category) + "\n")
        raise primary_failure
    if cleanup_failure is not None:
        raise FixtureSetupFailure("FIXTURE_CLEANUP_FAILURE", None, cleanup_failure)


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


def run_namespace_regressions(workspace, temp_root, ledger_path, outer_ids, outer_opt, uid, gid, node, corepack):
    run_owned_process_regressions(temp_root, ledger_path)
    run_fixture("leaked-holder", workspace=workspace, temp_root=temp_root, ledger_path=ledger_path, outer_ids=outer_ids, outer_opt=outer_opt, uid=uid, gid=gid, node=node, corepack=corepack)
    run_fixture("positive-release", workspace=workspace, temp_root=temp_root, ledger_path=ledger_path, outer_ids=outer_ids, outer_opt=outer_opt, uid=uid, gid=gid, node=node, corepack=corepack, retained_reference=True)
    run_fixture("cancel-opt", workspace=workspace, temp_root=temp_root, ledger_path=ledger_path, outer_ids=outer_ids, outer_opt=outer_opt, uid=uid, gid=gid, node=node, corepack=corepack)
    run_fixture("cancel-application", workspace=workspace, temp_root=temp_root, ledger_path=ledger_path, outer_ids=outer_ids, outer_opt=outer_opt, uid=uid, gid=gid, node=node, corepack=corepack)
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
    validate_fixture_diagnostic_controls()
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
    stage_root = None
    stage_cleanup_attempted = False
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
        run_namespace_regressions(workspace, temp_root, ledger, outer_ids, outer_opt, args.uid, args.gid, args.node, args.corepack)
        regressions_passed = True
        if ROOT_CANCEL_EVENT.is_set():
            raise Cancelled("HOSTED_NAMESPACE_CANCELLED_DURING_REGRESSIONS")
        holder, control_write, result_read, log, stage_root = launch_holder(
            "production", workspace=workspace, carrier=carrier, temp_root=temp_root,
            uid=args.uid, gid=args.gid, node=args.node, corepack=args.corepack,
            ledger_path=ledger, outer_ids=outer_ids, outer_opt=outer_opt,
        )
        holder_namespace = holder.mount_id
        holder_events(result_read, 90 * 60, events, cancel_event=ROOT_CANCEL_EVENT, cancel_callback=cancel_holder)
        holder_failure = holder_emitted_failure(events)
        if holder_failure is not None:
            raise holder_failure
        ready = [event for event in events if event.get("kind") == "stage" and event.get("name") == "NAMESPACE_READY"]
        barriers = [(index, event) for index, event in enumerate(events) if event.get("kind") == "barrier"]
        ready_index = next((index for index, event in enumerate(events) if event.get("kind") == "stage" and event.get("name") == "NAMESPACE_READY"), -1)
        if len(ready) != 1 or len(barriers) != 1 or barriers[0][0] < ready_index or not exact_barrier_event(barriers[0][1]):
            raise SupervisorFailure("NAMESPACE_HOLDER_BARRIER_INVALID")
        ready_namespace = ready[0].get("mountNamespace")
        if (
            type(ready_namespace) is not int
            or ready_namespace <= 0
            or ready[0].get("pid") != holder.pid
            or not holder.identity_valid()
        ):
            raise SupervisorFailure("NAMESPACE_HOLDER_IDENTITY_CHANGED")
        actual = namespace_identity(holder.pid, "mnt")
        if actual["number"] != ready_namespace:
            raise SupervisorFailure("NAMESPACE_HOLDER_IDENTITY_CHANGED")
        holder_namespace = ready_namespace
        holder.mount_id = holder_namespace
        validate_toolchain_preservation_events(events, holder_namespace, stage_root)
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
        stage_cleanup_attempted = True
        cleanup_toolchain_stage_root(temp_root, stage_root, namespace_closed=True)
        stage_root = None
        emit_to_stdout("HOSTED_TOOLCHAIN_NAMESPACE_RESOURCE_RELEASE=PASS\n")
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
        if stage_root is None and getattr(caught, "toolchain_stage_root", None) is not None:
            stage_root = Path(caught.toolchain_stage_root)
        if holder_namespace is None and getattr(caught, "toolchain_mount_namespace", None) is not None:
            holder_namespace = caught.toolchain_mount_namespace
        print("NAMESPACE_OPERATION_FAILURE=" + safe_failure(caught), file=sys.stderr)
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
                        cleanup_error = append_cleanup_failure(
                            cleanup_error,
                            SupervisorFailure("NAMESPACE_HOLDER_TEARDOWN_FAILED:" + safe_failure(terminate_error)),
                        )
        if holder is not None and holder.terminal is None and holder.process.poll() is not None:
            try:
                holder.wait(0)
            except Exception as error:
                cleanup_error = append_cleanup_failure(cleanup_error, error)
        if namespace_fd is not None:
            try:
                os.close(namespace_fd)
            except Exception as error:
                cleanup_error = append_cleanup_failure(cleanup_error, error)
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
            try:
                log.close()
            except Exception as error:
                cleanup_error = append_cleanup_failure(cleanup_error, error)
        try:
            if holder is not None and holder.terminal is None:
                raise SupervisorFailure("NAMESPACE_HOLDER_TERMINAL_WITNESS_MISSING")
            if holder_namespace is not None and not namespace_disappeared(holder_namespace, NAMESPACE_VERIFY_SECONDS):
                raise SupervisorFailure("NAMESPACE_REFERENCE_REMAINS_AFTER_TEARDOWN")
            if stage_root is not None and not stage_cleanup_attempted:
                stage_cleanup_attempted = True
                cleanup_toolchain_stage_root(temp_root, stage_root, namespace_closed=holder_namespace is None or namespace_disappeared(holder_namespace, NAMESPACE_VERIFY_SECONDS))
                stage_root = None
                emit_to_stdout("HOSTED_TOOLCHAIN_NAMESPACE_RESOURCE_RELEASE=PASS\n")
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
            cleanup_error = append_cleanup_failure(cleanup_error, error)
        for sig, handler in previous_handlers.items():
            try:
                signal.signal(sig, handler)
            except Exception as error:
                cleanup_error = append_cleanup_failure(cleanup_error, error)
    if operation_error is not None or cleanup_error is not None:
        report_failure_pair(operation_error, cleanup_error)
    if cleanup_error is not None:
        print("NAMESPACE_SUPERVISOR_STATE_CLEANUP=DEFERRED_UNRESOLVED", file=sys.stderr)
        raise effective_failure(operation_error, cleanup_error)
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
    try:
        outer_opt_reference = parse_outer_opt_reference(args.outer_opt_reference)
        return inner_holder(Path(args.workspace), Path(args.carrier), Path(args.temp_root), args.uid, args.gid, args.node, args.corepack, control_fd, result_fd, Path(args.ledger), args.outer_user_ns, args.outer_pid_ns, args.mode, outer_opt_reference, Path(args.toolchain_stage_root))
    except FixtureSetupFailure as error:
        if args.mode in {"fixture", "fixture-opt-cancel", "fixture-application-cancel"}:
            emit_fixture_failure(result_fd, error.category, error.primary_failure, error.cleanup_failure)
            return 2
        raise
    except Exception as error:
        if args.mode in {"fixture", "fixture-opt-cancel", "fixture-application-cancel"}:
            emit_fixture_failure(result_fd, "NAMESPACE_SETUP_FAILURE", error)
            return 2
        raise


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


def build_argument_parser():
    parser = argparse.ArgumentParser(add_help=False)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--supervise", action="store_true")
    mode.add_argument("--holder", action="store_true")
    parser.add_argument("--mode", choices=HOLDER_MODE_CHOICES, default="production")
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
    parser.add_argument("--outer-opt-reference", default="")
    parser.add_argument("--toolchain-stage-root", default="")
    parser.add_argument("--supervisor-pid", type=int, default=0)
    return parser


def main():
    if len(sys.argv) == 2 and sys.argv[1] == "--validate-fixture-diagnostics":
        validate_fixture_diagnostic_controls()
        return
    if len(sys.argv) == 4 and sys.argv[1] == "--validate-semantic-readback":
        validate_workflow_semantic_readback_files(Path(sys.argv[2]), Path(sys.argv[3]))
        return
    parser = build_argument_parser()
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
