#!/usr/bin/env python3
"""Bounded GitHub-hosted route-B mount namespace evidence harness."""

import argparse
import hashlib
import io
import json
import os
import posixpath
from pathlib import Path
import platform
import re
import selectors
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time


SCRIPT = Path(__file__).resolve()
HOSTEDTOOLCACHE = Path("/opt/hostedtoolcache")
OPT = Path("/opt")
RUNNER_ENV_DENY = re.compile(r"TOKEN|PASSWORD|SECRET|CREDENTIAL|PRIVATE_KEY|AUTH", re.IGNORECASE)
WORKFLOW_MARKERS = (
    "HOSTED_OPT_NAMESPACE=PASS",
    "HOSTED_PRIVATE_ROOT_ACL=PASS",
    "HOSTED_PRODUCT_PATHS_ON_INNER_OPT=PASS",
    "HOSTED_TOOLCHAIN_CONTINUITY=PASS",
    "BROKER_RECOVER=PASS",
    "BROKER_POLICY_ADMISSION=PASS",
    "POLICY_CANONICAL_ROUNDTRIP=PASS",
    "CONFIG_DIGEST_INCLUDES_POLICY_DIGEST=YES",
    "APPLICATION_PRIVATE_ROOT_BINDING=PASS",
    "APPLICATION_POLICY_H_BINDING=PASS",
    "APPLICATION_CONFIG_Q_BINDING=PASS",
    "APPLICATION_SANDBOX_BINDING=PASS",
    "SAME_POLICY_SNAPSHOT_BINDING=PASS",
    "PRODUCTION_BOUNDARY_PROOF=PASS",
    "FINAL_RUNTIME_ALLOWLIST_PROOF=PASS",
    "BROAD_RUNTIME_BINDS_ABSENT=YES",
    "NATIVE_RUNNER_ADMISSION_RESULT=PASS",
    "PINNED_BLENDER_RESULT=PASS",
    "PRIVATE_EXPORTER_RESULT=PASS",
    "NATIVE_VALIDATOR_RESULT=PASS",
    "BLENDER_SEMANTIC_QUALIFICATION=PASS",
    "SEMANTIC_READBACK_RESULT=PASS",
    "BROKER_RECOVERY_CLEANUP=PASS",
    "BROKER_DEPLOYMENT_CLEANUP=PASS",
    "PRODUCTION_DEPLOYMENT_ABSENT=YES",
    "CLEANUP=PASS",
    "S8_PINNED_BLENDER_CHECK=PASS",
)


class HarnessFailure(RuntimeError):
    def __init__(self, stage, detail):
        super().__init__(detail)
        self.stage = stage
        self.detail = detail


class CapabilityUnavailable(HarnessFailure):
    pass


class MechanismDefect(HarnessFailure):
    pass


def emit(name, value):
    print(f"{name}={value}", flush=True)


def decode_mount_path(value):
    return re.sub(r"\\([0-7]{3})", lambda match: chr(int(match.group(1), 8)), value)


def parse_mountinfo(text):
    mounts = []
    for row in text.splitlines():
        halves = row.split(" - ", 1)
        if len(halves) != 2:
            raise MechanismDefect("mountinfo_parse", "MOUNTINFO_ROW_INVALID")
        left, right = halves
        fields, filesystem = left.split(), right.split()
        if len(fields) < 6 or len(filesystem) < 3:
            raise MechanismDefect("mountinfo_parse", "MOUNTINFO_FIELDS_INVALID")
        mounts.append({
            "mount_id": fields[0],
            "parent_id": fields[1],
            "device": fields[2],
            "root": decode_mount_path(fields[3]),
            "mountpoint": decode_mount_path(fields[4]),
            "mount_options": fields[5],
            "optional": fields[6:],
            "filesystem": filesystem[0],
            "source": decode_mount_path(filesystem[1]),
            "super_options": filesystem[2],
        })
    return mounts


def mount_entry(mounts, target):
    target = posixpath.normpath(str(target))
    candidates = [
        row for row in mounts
        if row["mountpoint"] == "/"
        or target == row["mountpoint"]
        or target.startswith(row["mountpoint"].rstrip("/") + "/")
    ]
    if not candidates:
        raise HarnessFailure("mountinfo_lookup", "MOUNT_TARGET_NOT_FOUND")
    return max(candidates, key=lambda row: len(row["mountpoint"]))


def namespace_ids():
    try:
        result = {name: os.readlink(f"/proc/self/ns/{name}") for name in ("mnt", "user", "pid")}
    except OSError as error:
        raise CapabilityUnavailable("namespace_identity", "PROC_NAMESPACE_IDENTITY_UNAVAILABLE") from error
    for name, value in result.items():
        if not re.fullmatch(re.escape(name) + r":\[[0-9]+\]", value):
            raise MechanismDefect("namespace_identity", "PROC_NAMESPACE_IDENTITY_MALFORMED")
    return result


def stat_identity(path):
    try:
        metadata = os.lstat(path)
    except OSError as error:
        raise CapabilityUnavailable("path_identity", "RUNNER_PATH_IDENTITY_UNAVAILABLE:" + str(path)) from error
    return {
        "device": int(metadata.st_dev),
        "inode": int(metadata.st_ino),
        "mode": int(stat.S_IMODE(metadata.st_mode)),
        "kind": "directory" if stat.S_ISDIR(metadata.st_mode) else "regular" if stat.S_ISREG(metadata.st_mode) else "other",
        "uid": int(metadata.st_uid),
        "gid": int(metadata.st_gid),
        "special_bits": int(metadata.st_mode & (stat.S_ISUID | stat.S_ISGID | stat.S_ISVTX)),
    }


def checked(args, *, stage, env=None, timeout=10, capability=False):
    try:
        result = subprocess.run(args, check=False, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as error:
        error_type = CapabilityUnavailable if capability else MechanismDefect
        raise error_type(stage, "COMMAND_START_OR_TIMEOUT_FAILED:" + args[0]) from error
    if result.returncode != 0:
        detail = re.sub(r"[\r\n\t ]+", " ", (result.stderr or result.stdout).strip())[:400]
        error_type = CapabilityUnavailable if capability else MechanismDefect
        raise error_type(stage, f"COMMAND_EXIT_{result.returncode}:" + (detail or args[0]))
    return result.stdout


def acl_snapshot(path):
    base = ["/usr/bin/getfacl", "--numeric", "--omit-header", "--absolute-names", "--physical", "--all-effective"]
    try:
        access = checked(base + ["--access", "--", str(path)], stage="acl_read", capability=True)
        default = checked(base + ["--default", "--", str(path)], stage="default_acl_read", capability=True)
    except CapabilityUnavailable:
        raise
    return {"access": access, "default": default}


def file_digest(path):
    digest = hashlib.sha256()
    try:
        with open(path, "rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError as error:
        raise CapabilityUnavailable("toolchain_identity", "TOOLCHAIN_BINARY_UNREADABLE") from error
    return digest.hexdigest()


def node_identity(env):
    node = shutil.which("node", path=env.get("PATH", ""))
    if not node:
        raise CapabilityUnavailable("toolchain_identity", "NODE_NOT_FOUND_IN_HOSTED_PATH")
    resolved = str(Path(node).resolve(strict=True))
    try:
        common = os.path.commonpath([str(HOSTEDTOOLCACHE.resolve(strict=True)), resolved])
    except (OSError, ValueError) as error:
        raise CapabilityUnavailable("toolchain_identity", "HOSTEDTOOLCACHE_PATH_INVALID") from error
    if common != str(HOSTEDTOOLCACHE.resolve(strict=True)):
        raise CapabilityUnavailable("toolchain_identity", "NODE_NOT_FROM_HOSTEDTOOLCACHE")
    version = checked([resolved, "--version"], stage="node_version", env=env, timeout=5).strip()
    if not re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+", version):
        raise MechanismDefect("node_version", "NODE_VERSION_OUTPUT_INVALID")
    identity = stat_identity(resolved)
    return {
        "path": resolved,
        "version": version,
        "sha256": file_digest(resolved),
        "device": identity["device"],
        "inode": identity["inode"],
        "uid": identity["uid"],
        "gid": identity["gid"],
        "mode": identity["mode"],
    }


def safe_runner_environment(source):
    result = {}
    for name, value in source.items():
        if RUNNER_ENV_DENY.search(name):
            continue
        if name.startswith("GITHUB_") or name.startswith("RUNNER_") or name in {
            "PATH", "HOME", "USER", "LOGNAME", "SHELL", "PWD", "TMPDIR", "TMP", "TEMP",
            "CI", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "COREPACK_HOME",
            "COREPACK_ENABLE_AUTO_PIN", "NODE_OPTIONS", "S8_RUNNER_LABEL", "ImageOS", "ImageVersion",
        }:
            result[name] = value
    return result


def capture_outer_state(env):
    try:
        mount_text = Path("/proc/self/mountinfo").read_text(encoding="ascii")
    except (OSError, UnicodeError) as error:
        raise CapabilityUnavailable("outer_snapshot", "OUTER_MOUNTINFO_UNAVAILABLE") from error
    mounts = parse_mountinfo(mount_text)
    opt = stat_identity(OPT)
    if opt["kind"] != "directory" or stat.S_ISLNK(os.lstat(OPT).st_mode):
        raise CapabilityUnavailable("outer_snapshot", "OUTER_OPT_NOT_A_REAL_DIRECTORY")
    toolcache = stat_identity(HOSTEDTOOLCACHE)
    if toolcache["kind"] != "directory" or stat.S_ISLNK(os.lstat(HOSTEDTOOLCACHE).st_mode):
        raise CapabilityUnavailable("outer_snapshot", "HOSTEDTOOLCACHE_NOT_A_REAL_DIRECTORY")
    acl = acl_snapshot(OPT)
    toolchain = node_identity(env)
    os_release = {}
    try:
        for row in Path("/etc/os-release").read_text(encoding="ascii").splitlines():
            if "=" in row:
                key, value = row.split("=", 1)
                if key in {"ID", "VERSION_ID", "VERSION_CODENAME"}:
                    os_release[key] = value.strip('"')
    except (OSError, UnicodeError):
        os_release = {"ID": "UNAVAILABLE", "VERSION_ID": "UNAVAILABLE", "VERSION_CODENAME": "UNAVAILABLE"}
    outer_opt_mount = mount_entry(mounts, OPT)
    toolcache_mount = mount_entry(mounts, HOSTEDTOOLCACHE)
    try:
        groups = sorted(set(int(group) for group in os.getgroups()))
    except OSError as error:
        raise CapabilityUnavailable("caller_identity", "RUNNER_GROUP_IDENTITY_UNAVAILABLE") from error
    return {
        "namespaces": namespace_ids(),
        "runner": {"uid": os.getuid(), "gid": os.getgid(), "groups": groups},
        "os": os_release,
        "kernel": platform.release(),
        "runner_label": env.get("S8_RUNNER_LABEL", "UNAVAILABLE"),
        "runner_arch": env.get("RUNNER_ARCH", "UNAVAILABLE"),
        "opt": {"identity": opt, "mount": outer_opt_mount, "acl": acl},
        "toolcache": {"identity": toolcache, "mount": toolcache_mount},
        "toolchain": toolchain,
        "mountinfo_sha256": hashlib.sha256(mount_text.encode("ascii")).hexdigest(),
        "mountinfo": mount_text,
    }


def write_json(path, value, *, mode=0o600, uid=None, gid=None):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC, mode)
    try:
        payload = json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")
        with os.fdopen(descriptor, "wb", closefd=False) as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.fchmod(descriptor, mode)
        if uid is not None and gid is not None and os.geteuid() == 0:
            os.fchown(descriptor, uid, gid)
    finally:
        os.close(descriptor)


def read_json(path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise MechanismDefect("evidence_file", "NAMESPACE_EVIDENCE_FILE_INVALID") from error


def read_json_stdin():
    try:
        payload = sys.stdin.buffer.read(8 * 1024 * 1024 + 1)
        if len(payload) > 8 * 1024 * 1024:
            raise MechanismDefect("failure_control_input", "OUTER_SNAPSHOT_OVERSIZE")
        return json.loads(payload.decode("utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise MechanismDefect("failure_control_input", "OUTER_SNAPSHOT_INVALID") from error


def mount_table():
    try:
        text = Path("/proc/self/mountinfo").read_text(encoding="ascii")
    except (OSError, UnicodeError) as error:
        raise MechanismDefect("mountinfo_read", "INNER_MOUNTINFO_UNAVAILABLE") from error
    return text, parse_mountinfo(text)


def propagation_is_private(mounts):
    shared = []
    for row in mounts:
        if any(field.startswith(("shared:", "master:", "propagate_from:")) for field in row["optional"]):
            shared.append(row["mountpoint"])
    if shared:
        raise CapabilityUnavailable("mount_propagation_private", "MOUNT_PROPAGATION_STILL_SHARED")
    return True


def run_mount(args, stage):
    return checked(["/usr/bin/mount", *args], stage=stage, capability=True)


def run_unmount(path, expected_mount_id):
    _, mounts = mount_table()
    matches = [row for row in mounts if row["mountpoint"] == str(path)]
    if len(matches) != 1 or matches[0]["mount_id"] != expected_mount_id:
        raise MechanismDefect("known_mount_cleanup", "OWNED_MOUNT_IDENTITY_CHANGED")
    checked(["/usr/bin/umount", "--", str(path)], stage="known_mount_cleanup", timeout=15)


def mount_rows_under(mounts, root):
    root = str(root).rstrip("/") or "/"
    return [row for row in mounts if row["mountpoint"] == root or row["mountpoint"].startswith(root + "/")]


def setpriv_prefix(outer):
    groups = outer["runner"]["groups"]
    command = ["/usr/bin/setpriv", "--reuid", str(outer["runner"]["uid"]), "--regid", str(outer["runner"]["gid"])]
    if groups:
        command.extend(["--groups", ",".join(str(group) for group in groups)])
    else:
        command.append("--clear-groups")
    return command + ["--"]


def verify_inner_opt(outer):
    identity = stat_identity(OPT)
    try:
        mount_text, mounts = mount_table()
    except MechanismDefect:
        raise
    opt_mount = mount_entry(mounts, OPT)
    filesystem = checked(["/usr/bin/stat", "-f", "-c", "%T", "--", str(OPT)], stage="inner_opt_filesystem", capability=True).strip()
    acl = acl_snapshot(OPT)
    if identity["kind"] != "directory" or identity["uid"] != 0 or identity["gid"] != 0 or identity["mode"] != 0o755 or identity["special_bits"] != 0:
        raise MechanismDefect("inner_opt_identity", "INNER_OPT_IDENTITY_INVALID")
    if opt_mount["filesystem"] != "tmpfs" or filesystem != "tmpfs" or identity["device"] == outer["opt"]["identity"]["device"] or opt_mount["mount_id"] == outer["opt"]["mount"]["mount_id"]:
        raise MechanismDefect("inner_opt_filesystem", "INNER_OPT_NOT_DISTINCT")
    if acl["default"].strip():
        raise MechanismDefect("inner_opt_acl", "INNER_OPT_DEFAULT_ACL_PRESENT")
    access = [line.strip() for line in acl["access"].splitlines() if line.strip()]
    expected = {"user::rwx", "group::r-x", "other::r-x"}
    if set(access) != expected:
        raise MechanismDefect("inner_opt_acl", "INNER_OPT_ACCESS_ACL_UNEXPECTED")
    return {"identity": identity, "mount": opt_mount, "acl": acl, "mountinfo": mount_text, "mounts": mounts}


def verify_toolchain_in_namespace(outer, env):
    actual = node_identity(env)
    expected = outer["toolchain"]
    keys = ("path", "version", "sha256", "device", "inode", "uid", "gid", "mode")
    if any(actual[key] != expected[key] for key in keys):
        raise CapabilityUnavailable("toolchain_bind", "HOSTED_TOOLCHAIN_IDENTITY_CHANGED_AFTER_OPT_ISOLATION")
    toolcache = stat_identity(HOSTEDTOOLCACHE)
    toolcache_mount = mount_entry(mount_table()[1], HOSTEDTOOLCACHE)
    if (
        toolcache["device"] != outer["toolcache"]["identity"]["device"]
        or toolcache["inode"] != outer["toolcache"]["identity"]["inode"]
        or toolcache_mount["mount_id"] == outer["toolcache"]["mount"]["mount_id"]
    ):
        raise MechanismDefect("toolchain_bind", "HOSTEDTOOLCACHE_BIND_IDENTITY_INVALID")
    return actual, toolcache, toolcache_mount


def run_inner_workload(args):
    if os.geteuid() != 0 or os.getuid() != 0:
        raise CapabilityUnavailable("root_supervisor", "ROOT_SUPERVISOR_IDENTITY_UNAVAILABLE")
    outer = read_json(args.outer_state)
    safe_env = read_json(args.runner_environment)
    runner_uid, runner_gid = int(args.runner_uid), int(args.runner_gid)
    if (os.environ.get("GITHUB_WORKSPACE") or safe_env.get("GITHUB_WORKSPACE")) != safe_env.get("GITHUB_WORKSPACE"):
        raise MechanismDefect("runner_environment", "WORKSPACE_ENVIRONMENT_BINDING_INVALID")
    inner_ns = namespace_ids()
    if inner_ns["mnt"] == outer["namespaces"]["mnt"] or inner_ns["user"] != outer["namespaces"]["user"] or inner_ns["pid"] != outer["namespaces"]["pid"]:
        raise CapabilityUnavailable("mount_namespace_only", "NAMESPACE_DOMAIN_RELATION_INVALID")
    emit("ROOT_SUPERVISOR_UID", os.geteuid())
    emit("OUTER_MNT_NAMESPACE", outer["namespaces"]["mnt"])
    emit("INNER_MNT_NAMESPACE", inner_ns["mnt"])
    emit("OUTER_USER_NAMESPACE", outer["namespaces"]["user"])
    emit("INNER_USER_NAMESPACE", inner_ns["user"])
    emit("OUTER_PID_NAMESPACE", outer["namespaces"]["pid"])
    emit("INNER_PID_NAMESPACE", inner_ns["pid"])
    emit("MOUNT_NAMESPACE_DIFFERENT", "YES")
    emit("USER_NAMESPACE_SAME", "YES")
    emit("PID_NAMESPACE_SAME", "YES")

    run_mount(["--make-rprivate", "/"], "mount_propagation_private")
    _, initial_private_mounts = mount_table()
    propagation_is_private(initial_private_mounts)
    emit("MOUNT_PROPAGATION", "RECURSIVELY_PRIVATE")

    source_state = stat_identity(HOSTEDTOOLCACHE)
    if source_state != outer["toolcache"]["identity"]:
        raise CapabilityUnavailable("toolcache_source_identity", "HOSTEDTOOLCACHE_CHANGED_BEFORE_BIND")
    toolchain = outer["toolchain"]
    if not Path(toolchain["path"]).is_file():
        raise CapabilityUnavailable("toolchain_source", "NODE_BINARY_MISSING_BEFORE_BIND")

    run_id = safe_env.get("GITHUB_RUN_ID", "0")
    attempt = safe_env.get("GITHUB_RUN_ATTEMPT", "0")
    if not re.fullmatch(r"[0-9]+", run_id) or not re.fullmatch(r"[0-9]+", attempt):
        raise MechanismDefect("mount_staging", "RUN_IDENTITY_INVALID")
    staging_root = Path(args.outer_state).parent / f"toolcache-stage-{run_id}.{attempt}"
    if staging_root.exists() or staging_root.is_symlink():
        raise CapabilityUnavailable("toolcache_staging", "HOSTEDTOOLCACHE_STAGING_PATH_NOT_FRESH")
    staging_root.mkdir(mode=0o700)
    staged_toolcache = staging_root / "hostedtoolcache"
    staged_toolcache.mkdir(mode=0o700)
    run_mount(["--rbind", str(HOSTEDTOOLCACHE), str(staged_toolcache)], "hostedtoolcache_stage_bind")
    run_mount(["--make-rprivate", str(staged_toolcache)], "hostedtoolcache_stage_private")

    run_mount(["-t", "tmpfs", "-o", "size=4g,mode=0755,uid=0,gid=0,nosuid,nodev", "tmpfs", str(OPT)], "distinct_opt_tmpfs_mount")
    opt_info = verify_inner_opt(outer)
    emit("ROUTE_B_OPT_MOUNT_PROVEN", "PASS")
    (OPT / "hostedtoolcache").mkdir(mode=0o755)
    run_mount(["--rbind", str(staged_toolcache), str(HOSTEDTOOLCACHE)], "hostedtoolcache_restore_bind")
    run_mount(["--make-rprivate", str(HOSTEDTOOLCACHE)], "hostedtoolcache_restore_private")
    propagation_is_private(mount_table()[1])
    actual_toolchain, inner_toolcache, inner_toolcache_mount = verify_toolchain_in_namespace(outer, safe_env)
    namespace_expected_mountinfo, namespace_expected_mounts = mount_table()
    propagation_is_private(namespace_expected_mounts)
    emit("INNER_OPT_MOUNT_ID", opt_info["mount"]["mount_id"])
    emit("OUTER_OPT_MOUNT_ID", outer["opt"]["mount"]["mount_id"])
    emit("INNER_OPT_MOUNT_DEVICE", opt_info["mount"]["device"])
    emit("INNER_OPT_MOUNT_ROOT", opt_info["mount"]["root"])
    emit("INNER_OPT_MOUNT_SOURCE", opt_info["mount"]["source"])
    emit("INNER_OPT_MOUNT_FILESYSTEM", opt_info["mount"]["filesystem"])
    emit("INNER_OPT_DEVICE", opt_info["identity"]["device"])
    emit("INNER_OPT_INODE", opt_info["identity"]["inode"])
    emit("OUTER_OPT_DEVICE", outer["opt"]["identity"]["device"])
    emit("INNER_OPT_MODE", "0755")
    emit("INNER_OPT_ACCESS_ACL", "user::rwx,group::r-x,other::r-x")
    emit("INNER_OPT_DEFAULT_ACL", "ABSENT")
    emit("INNER_PROPAGATION_STATE", "ALL_PRIVATE")
    emit("HOSTEDTOOLCACHE_OUTER_MOUNT_ID", outer["toolcache"]["mount"]["mount_id"])
    emit("HOSTEDTOOLCACHE_INNER_MOUNT_ID", inner_toolcache_mount["mount_id"])
    emit("HOSTEDTOOLCACHE_DEVICE", inner_toolcache["device"])
    emit("NODE_TOOLCHAIN_PATH", actual_toolchain["path"])
    emit("NODE_TOOLCHAIN_VERSION", actual_toolchain["version"])
    emit("NODE_TOOLCHAIN_SHA256", actual_toolchain["sha256"])
    emit("HOSTEDTOOLCACHE_RUNTIME_ALLOWLIST", "HARNESS_ONLY")
    emit("ROUTE_B_NAMESPACE_SETUP", "PASS")

    safe_env.update({
        "S8_MOUNT_NAMESPACE_ACTIVE": "1",
        "S8_NAMESPACE_OUTER_MNT": outer["namespaces"]["mnt"],
        "S8_NAMESPACE_INNER_MNT": inner_ns["mnt"],
        "S8_NAMESPACE_OUTER_USER": outer["namespaces"]["user"],
        "S8_NAMESPACE_INNER_USER": inner_ns["user"],
        "S8_NAMESPACE_OUTER_PID": outer["namespaces"]["pid"],
        "S8_NAMESPACE_INNER_PID": inner_ns["pid"],
        "S8_NAMESPACE_OUTER_OPT_MOUNT_ID": outer["opt"]["mount"]["mount_id"],
        "S8_NAMESPACE_OUTER_OPT_DEVICE": str(outer["opt"]["identity"]["device"]),
        "S8_NAMESPACE_INNER_OPT_MOUNT_ID": opt_info["mount"]["mount_id"],
        "S8_NAMESPACE_TOOLCHAIN_CONTINUITY": "PASS",
        "S8_NAMESPACE_TOOLCHAIN_NODE_SHA256": actual_toolchain["sha256"],
    })
    workspace = Path(safe_env.get("GITHUB_WORKSPACE", ""))
    script = Path(args.workflow_script)
    if not workspace.is_dir() or not script.is_file() or script.is_symlink():
        raise MechanismDefect("workflow_script_identity", "WORKFLOW_STEP_SCRIPT_UNAVAILABLE")
    if os.getuid() != 0:
        raise MechanismDefect("root_supervisor_identity", "ROOT_SUPERVISOR_UID_CHANGED")

    prefix = setpriv_prefix(outer)
    identity_env = dict(safe_env)
    identity_cmd = prefix + ["/usr/bin/id", "-u"]
    actual_uid = checked(identity_cmd, stage="caller_identity", env=identity_env, timeout=5).strip()
    actual_gid = checked(prefix + ["/usr/bin/id", "-g"], stage="caller_identity", env=identity_env, timeout=5).strip()
    inner_groups_text = checked(prefix + ["/usr/bin/id", "-G"], stage="caller_identity", env=identity_env, timeout=5)
    try:
        inner_groups = sorted(set(int(value) for value in inner_groups_text.split()))
    except ValueError as error:
        raise MechanismDefect("caller_identity", "INNER_RUNNER_GROUP_OUTPUT_INVALID") from error
    expected_groups = sorted(set(outer["runner"]["groups"] + [outer["runner"]["gid"]]))
    if (actual_uid, actual_gid, inner_groups) != (str(runner_uid), str(runner_gid), expected_groups):
        raise MechanismDefect("caller_identity", "HOSTED_CALLER_IDENTITY_NOT_PRESERVED")
    emit("HOSTED_CALLER_UID", actual_uid)
    emit("HOSTED_CALLER_GID", actual_gid)
    emit("HOSTED_CALLER_GROUPS", ",".join(str(group) for group in inner_groups))
    emit("HOSTED_CALLER_IDENTITY", "PASS")
    caller_node_version = checked(prefix + [actual_toolchain["path"], "--version"], stage="caller_toolchain", env=identity_env, timeout=5).strip()
    caller_node_exec = checked(prefix + [actual_toolchain["path"], "-p", "process.execPath"], stage="caller_toolchain", env=identity_env, timeout=5).strip()
    if caller_node_version != actual_toolchain["version"] or str(Path(caller_node_exec).resolve(strict=True)) != actual_toolchain["path"]:
        raise MechanismDefect("caller_toolchain", "HOSTED_CALLER_NODE_IDENTITY_INVALID")
    emit("NODE_TOOLCHAIN_CALLER_UID", actual_uid)
    emit("NODE_TOOLCHAIN_EXECUTION", "PASS")

    workflow = subprocess.Popen(
        prefix + ["/usr/bin/bash", "--noprofile", "--norc", "-e", "-o", "pipefail", str(script)],
        cwd=str(workspace), env=safe_env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, encoding="utf-8", errors="replace", bufsize=1,
    )
    observed = set()
    for line in workflow.stdout:
        sys.stdout.write(line)
        sys.stdout.flush()
        stripped = line.strip()
        if "=" in stripped:
            observed.add(stripped)
    workflow_status = workflow.wait()
    emit("HOSTED_WORKFLOW_STEP_EXIT", workflow_status)

    current_mount_text, current_mounts = mount_table()
    mounts_unchanged = current_mount_text == namespace_expected_mountinfo
    if not mounts_unchanged:
        emit("INNER_UNEXPECTED_MOUNTS", "YES")
    survivors = namespace_processes(inner_ns["mnt"], exclude_pid=os.getpid())
    emit("INNER_NAMESPACE_SURVIVING_PROCESS_COUNT", len(survivors))
    if survivors:
        raise HarnessFailure("normal_teardown", "INNER_NAMESPACE_CHILDREN_REMAIN:" + ",".join(str(pid) for pid in survivors[:8]))
    if not mounts_unchanged:
        raise HarnessFailure("normal_teardown", "INNER_UNEXPECTED_MOUNTS_REMAIN")

    if workflow_status == 0:
        missing = [marker for marker in WORKFLOW_MARKERS if marker not in observed]
        if missing:
            raise MechanismDefect("production_lifecycle_evidence", "WORKFLOW_EVIDENCE_MARKERS_MISSING:" + ",".join(missing[:6]))
        for path in (Path("/var/lib/swooshz/s8"), Path("/opt/blender"), Path("/opt/swooshz")):
            if path.exists() or path.is_symlink():
                raise HarnessFailure("normal_teardown", "PRODUCT_RESIDUE_REMAINS:" + str(path))
        emit("INNER_PRODUCT_RESIDUE", "ABSENT")
    else:
        emit("INNER_PRODUCT_LIFECYCLE", "NOT_COMPLETE")

    # Only detach mounts created by this harness, after its caller and workflow children are gone.
    owned_opt_mount = opt_info["mount"]["mount_id"]
    toolcache_mounts = mount_rows_under(namespace_expected_mounts, HOSTEDTOOLCACHE)
    staged_mounts = mount_rows_under(namespace_expected_mounts, staged_toolcache)
    for row in sorted(toolcache_mounts, key=lambda item: len(item["mountpoint"]), reverse=True):
        run_unmount(row["mountpoint"], row["mount_id"])
    run_unmount(OPT, owned_opt_mount)
    for row in sorted(staged_mounts, key=lambda item: len(item["mountpoint"]), reverse=True):
        run_unmount(row["mountpoint"], row["mount_id"])
    try:
        staged_toolcache.rmdir()
        staging_root.rmdir()
    except OSError as error:
        raise HarnessFailure("mount_staging_cleanup", "OWNED_STAGING_DIRECTORY_REMAINS") from error
    restored = stat_identity(OPT)
    restored_mount = mount_entry(mount_table()[1], OPT)
    if restored != outer["opt"]["identity"] or restored_mount["mount_id"] != outer["opt"]["mount"]["mount_id"]:
        raise HarnessFailure("normal_teardown", "INNER_OPT_DID_NOT_RESTORE_OUTER_IDENTITY")
    if workflow_status != 0:
        emit("ROUTE_B_PRODUCTION_LIFECYCLE", "HOLD")
        return 80
    emit("INNER_MOUNT_TEARDOWN", "PASS")
    emit("ROUTE_B_PRODUCTION_LIFECYCLE", "PASS")
    return 0


def namespace_processes(mnt_identity, *, exclude_pid=None):
    result = []
    try:
        entries = list(Path("/proc").iterdir())
    except OSError as error:
        raise HarnessFailure("process_quiescence", "PROC_PROCESS_LIST_UNAVAILABLE") from error
    for entry in entries:
        if not entry.name.isdigit() or (exclude_pid is not None and int(entry.name) == exclude_pid):
            continue
        try:
            identity = os.readlink(entry / "ns/mnt")
        except (FileNotFoundError, ProcessLookupError):
            continue
        except OSError as error:
            raise HarnessFailure("process_quiescence", "PROC_NAMESPACE_IDENTITY_UNAVAILABLE") from error
        if identity == mnt_identity:
            result.append(int(entry.name))
    return sorted(result)


def namespace_process_check(mnt_identity):
    if os.geteuid() != 0 or not re.fullmatch(r"mnt:\[[0-9]+\]", mnt_identity):
        raise MechanismDefect("process_quiescence", "NAMESPACE_PROCESS_CHECK_INVALID")
    survivors = namespace_processes(mnt_identity)
    emit("FAILURE_CONTROL_NAMESPACE_PROCESS_COUNT", len(survivors))
    return 1 if survivors else 0


def negative_child(args):
    if os.getuid() != 0 or os.geteuid() != 0:
        raise CapabilityUnavailable("failure_control_root", "FAILURE_CONTROL_ROOT_SUPERVISOR_UNAVAILABLE")
    outer = read_json_stdin()
    inner_ns = namespace_ids()
    if inner_ns["mnt"] == outer["namespaces"]["mnt"] or inner_ns["user"] != outer["namespaces"]["user"] or inner_ns["pid"] != outer["namespaces"]["pid"]:
        raise CapabilityUnavailable("failure_control_namespace", "FAILURE_CONTROL_NAMESPACE_RELATION_INVALID")
    run_mount(["--make-rprivate", "/"], "failure_control_private_propagation")
    _, mounts = mount_table()
    propagation_is_private(mounts)
    run_mount(["-t", "tmpfs", "-o", "size=64m,mode=0755,uid=0,gid=0,nosuid,nodev", "tmpfs", str(OPT)], "failure_control_opt_mount")
    opt_identity = stat_identity(OPT)
    opt_mount = mount_entry(mount_table()[1], OPT)
    filesystem = checked(["/usr/bin/stat", "-f", "-c", "%T", "--", str(OPT)], stage="failure_control_opt_probe", capability=True).strip()
    acl = acl_snapshot(OPT)
    if (
        opt_identity["uid"] != 0 or opt_identity["gid"] != 0 or opt_identity["mode"] != 0o755
        or opt_identity["device"] == outer["opt"]["identity"]["device"]
        or opt_mount["mount_id"] == outer["opt"]["mount"]["mount_id"]
        or filesystem != "tmpfs" or acl["default"].strip()
    ):
        raise MechanismDefect("failure_control_opt_mount", "FAILURE_CONTROL_DISTINCT_OPT_NOT_PROVEN")
    record = {
        "pid": os.getpid(),
        "mnt": inner_ns["mnt"],
        "user": inner_ns["user"],
        "pidns": inner_ns["pid"],
        "opt_mount_id": opt_mount["mount_id"],
        "opt_device": opt_identity["device"],
    }
    emit("FAILURE_CONTROL_PHASE", "DISTINCT_OPT_MOUNT_EXISTS")
    emit("FAILURE_CONTROL_INNER_MNT", inner_ns["mnt"])
    emit("FAILURE_CONTROL_INNER_OPT_MOUNT_ID", opt_mount["mount_id"])
    emit("FAILURE_CONTROL_READY_JSON", json.dumps(record, sort_keys=True, separators=(",", ":")))
    # The outer harness terminates this exact process after the ready record is verified.
    while True:
        signal.pause()


def verify_outer_unchanged(before, *, label):
    env = safe_runner_environment(os.environ)
    after = capture_outer_state(env)
    if before != after:
        emit(label, "FAIL")
        emit("OUTER_OPT_UNCHANGED", "NO")
        raise HarnessFailure("outer_non_interference", "OUTER_STATE_CHANGED:" + label)
    emit(label, "PASS")
    emit("OUTER_OPT_UNCHANGED", "YES")
    emit("OUTER_MOUNT_TABLE_UNCHANGED", "YES")
    emit("OUTER_OPT_MOUNT_ID", before["opt"]["mount"]["mount_id"])
    emit("OUTER_OPT_DEVICE_INODE", f"{before['opt']['identity']['device']}:{before['opt']['identity']['inode']}")
    emit("OUTER_OPT_OWNER_MODE", f"{before['opt']['identity']['uid']}:{before['opt']['identity']['gid']}:{before['opt']['identity']['mode']:04o}")
    emit("OUTER_OPT_ACCESS_ACL", ",".join(line.strip() for line in before["opt"]["acl"]["access"].splitlines() if line.strip()) or "ABSENT")
    emit("OUTER_OPT_DEFAULT_ACL", ",".join(line.strip() for line in before["opt"]["acl"]["default"].splitlines() if line.strip()) or "ABSENT")
    emit("OUTER_OPT_PROPAGATION", ",".join(before["opt"]["mount"]["optional"]) or "PRIVATE_OR_UNSHARED")


def terminate_failure_supervisor(process):
    if process.poll() is None:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait(timeout=5)
    if process.stdout is not None:
        process.stdout.read()


def wait_for_failure_ready(process, timeout=15):
    deadline = time.monotonic() + timeout
    output = []
    buffer = bytearray()
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    try:
        while time.monotonic() < deadline:
            remaining = max(0.0, deadline - time.monotonic())
            if selector.select(min(remaining, 0.1)):
                chunk = os.read(process.stdout.fileno(), 4096)
                if not chunk:
                    if process.poll() is not None:
                        break
                    continue
                buffer.extend(chunk)
                if len(buffer) > 16384 and b"\n" not in buffer:
                    raise MechanismDefect("failure_control_ready", "FAILURE_CONTROL_OUTPUT_OVERSIZE")
                while b"\n" in buffer:
                    raw_line, _, remainder = buffer.partition(b"\n")
                    buffer = bytearray(remainder)
                    stripped = raw_line.decode("utf-8", errors="replace").strip()
                    if stripped.startswith("FAILURE_CONTROL_READY_JSON="):
                        try:
                            record = json.loads(stripped.split("=", 1)[1])
                        except json.JSONDecodeError as error:
                            raise MechanismDefect("failure_control_ready", "FAILURE_CONTROL_READY_RECORD_INVALID") from error
                        if not isinstance(record, dict):
                            raise MechanismDefect("failure_control_ready", "FAILURE_CONTROL_READY_RECORD_INVALID")
                        return record
                    output.append(stripped)
            if process.poll() is not None:
                break
    except MechanismDefect:
        terminate_failure_supervisor(process)
        raise
    terminate_failure_supervisor(process)
    detail = re.sub(r"[\r\n\t ]+", " ", " ".join(output))[:400]
    raise HarnessFailure("failure_control", "FAILURE_CONTROL_DID_NOT_REACH_OPT_MOUNT:" + (detail or "TIMEOUT"))


def run_failure_control(outer, workdir):
    command = [
        "/usr/bin/sudo", "-n", "/usr/bin/unshare", "--kill-child=TERM", "--mount", "--fork", "--",
        "/usr/bin/python3", str(SCRIPT), "--negative-child",
        "--runner-uid", str(outer["runner"]["uid"]), "--runner-gid", str(outer["runner"]["gid"]),
    ]
    try:
        process = subprocess.Popen(command, cwd=str(workdir), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, bufsize=0, start_new_session=True)
    except OSError as error:
        raise CapabilityUnavailable("failure_control_unshare", "FAILURE_CONTROL_UNSHARE_UNAVAILABLE") from error
    try:
        payload = json.dumps(outer, sort_keys=True, separators=(",", ":")).encode("utf-8")
        written = 0
        while written < len(payload):
            count = process.stdin.write(payload[written:])
            if not count:
                raise OSError("SNAPSHOT_PIPE_CLOSED")
            written += count
        process.stdin.close()
    except (BrokenPipeError, OSError) as error:
        terminate_failure_supervisor(process)
        raise HarnessFailure("failure_control_input", "FAILURE_CONTROL_SNAPSHOT_DELIVERY_FAILED") from error
    record = wait_for_failure_ready(process)
    if (
        type(record.get("pid")) is not int or record["pid"] <= 0
        or not isinstance(record.get("mnt"), str) or not re.fullmatch(r"mnt:\[[0-9]+\]", record["mnt"])
        or not isinstance(record.get("user"), str) or not re.fullmatch(r"user:\[[0-9]+\]", record["user"])
        or not isinstance(record.get("pidns"), str) or not re.fullmatch(r"pid:\[[0-9]+\]", record["pidns"])
        or type(record.get("opt_device")) is not int
        or record.get("mnt") == outer["namespaces"]["mnt"]
        or record.get("user") != outer["namespaces"]["user"]
        or record.get("pidns") != outer["namespaces"]["pid"]
        or record.get("opt_device") == outer["opt"]["identity"]["device"]
        or not re.fullmatch(r"[1-9][0-9]*", str(record.get("opt_mount_id", "")))
    ):
        terminate_failure_supervisor(process)
        raise MechanismDefect("failure_control_identity", "FAILURE_CONTROL_READY_IDENTITY_INVALID")
    emit("FAILURE_CONTROL_CHILD_PID", record["pid"])
    emit("FAILURE_CONTROL_INNER_MNT", record["mnt"])
    emit("FAILURE_CONTROL_INNER_USER", record["user"])
    emit("FAILURE_CONTROL_INNER_PID", record["pidns"])
    emit("FAILURE_CONTROL_INNER_OPT_MOUNT_ID", record["opt_mount_id"])
    emit("FAILURE_CONTROL_INNER_OPT_DEVICE", record["opt_device"])
    try:
        for name, expected in (("mnt", record["mnt"]), ("user", record["user"]), ("pid", record["pidns"])):
            actual = checked(
                ["/usr/bin/sudo", "-n", "/usr/bin/readlink", f"/proc/{record['pid']}/ns/{name}"],
                stage="failure_control_cancel_identity", timeout=5, capability=True,
            ).strip()
            if actual != expected:
                raise MechanismDefect("failure_control_cancel", "FAILURE_CONTROL_CHILD_NAMESPACE_CHANGED")
        checked(
            ["/usr/bin/sudo", "-n", "/usr/bin/kill", "-TERM", "--", str(record["pid"])],
            stage="failure_control_cancel", timeout=5, capability=True,
        )
    except HarnessFailure:
        terminate_failure_supervisor(process)
        raise
    emit("FAILURE_CONTROL_CHILD_NAMESPACE_VERIFIED", "YES")
    try:
        status = process.wait(timeout=15)
    except subprocess.TimeoutExpired as error:
        terminate_failure_supervisor(process)
        raise HarnessFailure("failure_control", "FAILURE_CONTROL_PARENT_DID_NOT_REAP_CHILD") from error
    process.stdout.read()
    if status == 0:
        raise MechanismDefect("failure_control_cancel", "FAILURE_CONTROL_DID_NOT_TERMINATE")
    emit("FAILURE_CONTROL_SIGNAL", "SIGTERM")
    emit("FAILURE_CONTROL_SUPERVISOR_EXIT", status)
    quiescence = checked(
        ["/usr/bin/sudo", "-n", "/usr/bin/python3", str(SCRIPT), "--namespace-process-check", record["mnt"]],
        stage="failure_control_quiescence", timeout=10, capability=True,
    ).strip()
    if quiescence != "FAILURE_CONTROL_NAMESPACE_PROCESS_COUNT=0":
        raise HarnessFailure("failure_control", "FAILURE_CONTROL_NAMESPACE_PROCESS_REMAINS")
    emit("FAILURE_CONTROL_PHASE", "TERMINATED_AFTER_DISTINCT_OPT_MOUNT")
    emit("FAILURE_CONTROL_CHILD_REAPED", "YES")
    emit("FAILURE_CONTROL_NAMESPACE_PROCESSES", 0)
    emit("FAILURE_CONTROL_RESULT", "PASS")


def run_hosted_step(workflow_script):
    env = safe_runner_environment(os.environ)
    try:
        outer = capture_outer_state(env)
    except HarnessFailure as error:
        emit("ROUTE_B_CAPABILITY_UNAVAILABLE", "YES")
        emit("FAILED_OPERATION", error.stage)
        emit("CAPABILITY_DETAIL", error.detail)
        emit("RUNNER_OS", json.dumps({"label": env.get("S8_RUNNER_LABEL", "UNAVAILABLE"), "arch": env.get("RUNNER_ARCH", "UNAVAILABLE"), "kernel": platform.release()}))
        return 2
    emit("RUNNER_OS_ID", outer["os"].get("ID", "UNAVAILABLE"))
    emit("RUNNER_OS_VERSION", outer["os"].get("VERSION_ID", "UNAVAILABLE"))
    emit("RUNNER_KERNEL", outer["kernel"])
    emit("RUNNER_LABEL", outer["runner_label"])
    emit("RUNNER_ARCH", outer["runner_arch"])
    emit("RUNNER_UID", outer["runner"]["uid"])
    emit("RUNNER_GID", outer["runner"]["gid"])
    emit("OUTER_MNT_NAMESPACE", outer["namespaces"]["mnt"])
    emit("OUTER_USER_NAMESPACE", outer["namespaces"]["user"])
    emit("OUTER_PID_NAMESPACE", outer["namespaces"]["pid"])
    emit("OUTER_OPT_MOUNT_ID", outer["opt"]["mount"]["mount_id"])
    emit("OUTER_OPT_FILESYSTEM", outer["opt"]["mount"]["filesystem"])
    emit("OUTER_OPT_DEVICE_INODE", f"{outer['opt']['identity']['device']}:{outer['opt']['identity']['inode']}")
    emit("OUTER_OPT_MOUNT_DEVICE", outer["opt"]["mount"]["device"])
    emit("OUTER_OPT_MOUNT_ROOT", outer["opt"]["mount"]["root"])
    emit("OUTER_OPT_MOUNT_SOURCE", outer["opt"]["mount"]["source"])
    emit("OUTER_OPT_ACCESS_ACL_BEFORE", ",".join(line.strip() for line in outer["opt"]["acl"]["access"].splitlines() if line.strip()) or "ABSENT")
    emit("OUTER_OPT_DEFAULT_ACL_BEFORE", ",".join(line.strip() for line in outer["opt"]["acl"]["default"].splitlines() if line.strip()) or "ABSENT")
    emit("OUTER_OPT_PROPAGATION_BEFORE", ",".join(outer["opt"]["mount"]["optional"]) or "PRIVATE_OR_UNSHARED")
    emit("OUTER_OPT_OWNER_MODE", f"{outer['opt']['identity']['uid']}:{outer['opt']['identity']['gid']}:{outer['opt']['identity']['mode']:04o}")
    emit("NODE_TOOLCHAIN_PATH", outer["toolchain"]["path"])
    emit("NODE_TOOLCHAIN_VERSION", outer["toolchain"]["version"])
    emit("NODE_TOOLCHAIN_SHA256", outer["toolchain"]["sha256"])

    runner_temp = Path(env.get("RUNNER_TEMP", ""))
    try:
        runner_temp = runner_temp.resolve(strict=True)
        if not runner_temp.is_dir() or runner_temp.is_symlink():
            raise OSError("RUNNER_TEMP_INVALID")
        workdir = Path(tempfile.mkdtemp(prefix="s8-opt-namespace-", dir=str(runner_temp)))
        os.chmod(workdir, 0o700)
    except OSError as error:
        emit("ROUTE_B_CAPABILITY_UNAVAILABLE", "YES")
        emit("FAILED_OPERATION", "RUNNER_TEMP_EVIDENCE_ROOT")
        emit("CAPABILITY_DETAIL", "RUNNER_TEMP_NOT_USABLE")
        return 2
    state_path = workdir / "outer-state.json"
    env_path = workdir / "runner-environment.json"
    write_json(state_path, outer)
    write_json(env_path, env)
    workflow_script = Path(workflow_script).resolve(strict=True)
    command = [
        "/usr/bin/sudo", "-n", "/usr/bin/unshare", "--mount", "--fork", "--",
        "/usr/bin/python3", str(SCRIPT), "--inner-run",
        "--outer-state", str(state_path), "--runner-environment", str(env_path),
        "--workflow-script", str(workflow_script),
        "--runner-uid", str(outer["runner"]["uid"]), "--runner-gid", str(outer["runner"]["gid"]),
    ]
    try:
        process = subprocess.Popen(command, cwd=env.get("GITHUB_WORKSPACE"), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace", bufsize=1)
    except OSError as error:
        emit("ROUTE_B_CAPABILITY_UNAVAILABLE", "YES")
        emit("FAILED_OPERATION", "SUDO_UNSHARE_MOUNT_NAMESPACE")
        emit("CAPABILITY_DETAIL", "ROOT_MOUNT_NAMESPACE_COMMAND_UNAVAILABLE")
        shutil.rmtree(workdir)
        return 2
    output_markers = set()
    for line in process.stdout:
        sys.stdout.write(line)
        sys.stdout.flush()
        stripped = line.strip()
        if "=" in stripped:
            output_markers.add(stripped)
    status = process.wait()
    namespace_ready = "ROUTE_B_NAMESPACE_SETUP=PASS" in output_markers
    opt_mount_proven = "ROUTE_B_OPT_MOUNT_PROVEN=PASS" in output_markers
    try:
        verify_outer_unchanged(outer, label="OUTER_STATE_AFTER_SUCCESS_EPISODE")
    except HarnessFailure as error:
        emit("ROUTE_B_EVIDENCE_HOLD", "OUTER_NON_INTERFERENCE_FAILED")
        emit("TEARDOWN_DETAIL", error.detail)
        shutil.rmtree(workdir, ignore_errors=True)
        return 3
    if opt_mount_proven:
        try:
            run_failure_control(outer, workdir)
            verify_outer_unchanged(outer, label="OUTER_STATE_AFTER_FAILURE_CONTROL")
        except HarnessFailure as error:
            emit("ROUTE_B_EVIDENCE_HOLD", "FAILURE_CONTROL_OR_OUTER_STATE_FAILED")
            emit("TEARDOWN_DETAIL", error.detail)
            shutil.rmtree(workdir, ignore_errors=True)
            return 4
    else:
        emit("FAILURE_CONTROL_RESULT", "NOT_RUN_DISTINCT_OPT_MOUNT_NOT_PROVEN")
    try:
        shutil.rmtree(workdir)
    except OSError:
        emit("HARNESS_TEMP_CLEANUP", "HOLD")
        return 5
    if not namespace_ready:
        if "ROUTE_B_CAPABILITY_UNAVAILABLE=YES" in output_markers or "ROUTE_B_MECHANISM_DEFECT=YES" in output_markers:
            return status if status != 0 else 6
        emit("ROUTE_B_EVIDENCE_HOLD", "INNER_NAMESPACE_SETUP_INCOMPLETE")
        emit("HOSTED_STEP_EXIT", status)
        return status if status != 0 else 6
    if status != 0:
        emit("ROUTE_B_EVIDENCE_HOLD", "PRODUCTION_LIFECYCLE_OR_HARNESS_STEP_FAILED")
        emit("HOSTED_STEP_EXIT", status)
        return status
    emit("ROUTE_B_CAPABILITY_PROVEN", "YES")
    emit("ROUTE_B_PRODUCTION_LIFECYCLE", "PASS")
    emit("OUTER_STATE_AFTER_SUCCESS", "UNCHANGED")
    emit("OUTER_STATE_AFTER_FAILURE_CONTROL", "UNCHANGED")
    emit("NORMAL_TEARDOWN", "PASS")
    emit("FAILURE_CANCELLATION_TEARDOWN", "PASS")
    return 0


def run_inner_cli(args):
    try:
        status = run_inner_workload(args)
        return status
    except CapabilityUnavailable as error:
        emit("ROUTE_B_CAPABILITY_UNAVAILABLE", "YES")
        emit("FAILED_OPERATION", error.stage)
        emit("CAPABILITY_DETAIL", error.detail)
        return 90
    except MechanismDefect as error:
        emit("ROUTE_B_MECHANISM_DEFECT", "YES")
        emit("FAILED_OPERATION", error.stage)
        emit("MECHANISM_DETAIL", error.detail)
        return 91
    except HarnessFailure as error:
        emit("ROUTE_B_EVIDENCE_HOLD", error.stage)
        emit("TEARDOWN_DETAIL", error.detail)
        return 92
    except Exception as error:
        emit("ROUTE_B_MECHANISM_DEFECT", "YES")
        emit("FAILED_OPERATION", "INNER_UNHANDLED_EXCEPTION")
        emit("MECHANISM_DETAIL", type(error).__name__)
        return 93


def run_negative_child_cli(args):
    try:
        negative_child(args)
    except CapabilityUnavailable as error:
        emit("ROUTE_B_CAPABILITY_UNAVAILABLE", "YES")
        emit("FAILED_OPERATION", error.stage)
        emit("CAPABILITY_DETAIL", error.detail)
        return 90
    except (MechanismDefect, HarnessFailure) as error:
        emit("ROUTE_B_MECHANISM_DEFECT", "YES")
        emit("FAILED_OPERATION", error.stage)
        emit("MECHANISM_DETAIL", error.detail)
        return 91
    return 0


def self_test():
    sample = "36 25 0:32 / / rw,relatime shared:1 - ext4 /dev/root rw\n37 36 0:43 / /opt rw,relatime - tmpfs tmpfs rw"
    rows = parse_mountinfo(sample)
    assert mount_entry(rows, "/opt")["mount_id"] == "37"
    assert mount_entry(rows, "/opt/blender")["filesystem"] == "tmpfs"
    assert decode_mount_path("/run/a\\040b") == "/run/a b"
    try:
        propagation_is_private(rows)
    except CapabilityUnavailable as error:
        assert error.stage == "mount_propagation_private"
    else:
        raise AssertionError("shared propagation was accepted")
    safe = safe_runner_environment({"PATH": "/bin", "GITHUB_RUN_ID": "1", "GITHUB_TOKEN": "not-persisted", "ACTIONS_RUNTIME_TOKEN": "not-persisted", "S8_RUNNER_LABEL": "ubuntu-24.04"})
    assert safe == {"PATH": "/bin", "GITHUB_RUN_ID": "1", "S8_RUNNER_LABEL": "ubuntu-24.04"}
    original_stdin = sys.stdin
    probe_stdin = io.TextIOWrapper(io.BytesIO(b'{"snapshot":"bounded"}'), encoding="utf-8")
    try:
        sys.stdin = probe_stdin
        assert read_json_stdin() == {"snapshot": "bounded"}
    finally:
        sys.stdin = original_stdin
        probe_stdin.close()
    if os.name == "posix":
        child = subprocess.Popen(
            [sys.executable, "-c", "import json,time; print('FAILURE_CONTROL_READY_JSON=' + json.dumps({'pid': 7}), flush=True); time.sleep(30)"],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, bufsize=0, start_new_session=True,
        )
        try:
            assert wait_for_failure_ready(child, timeout=2) == {"pid": 7}
        finally:
            terminate_failure_supervisor(child)
    emit("HOSTED_NAMESPACE_HARNESS_SELF_TEST", "PASS")
    return 0


def main():
    parser = argparse.ArgumentParser()
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument("--self-test", action="store_true")
    modes.add_argument("--hosted-namespace-run", metavar="WORKFLOW_SCRIPT")
    modes.add_argument("--inner-run", action="store_true")
    modes.add_argument("--negative-child", action="store_true")
    modes.add_argument("--namespace-process-check", metavar="NAMESPACE_ID")
    parser.add_argument("--outer-state")
    parser.add_argument("--runner-environment")
    parser.add_argument("--workflow-script")
    parser.add_argument("--runner-uid")
    parser.add_argument("--runner-gid")
    args = parser.parse_args()
    if args.self_test:
        return self_test()
    if args.hosted_namespace_run:
        return run_hosted_step(args.hosted_namespace_run)
    if args.inner_run:
        if not all((args.outer_state, args.runner_environment, args.workflow_script, args.runner_uid, args.runner_gid)):
            emit("ROUTE_B_MECHANISM_DEFECT", "YES")
            emit("MECHANISM_DETAIL", "INNER_ARGUMENTS_INCOMPLETE")
            return 91
        return run_inner_cli(args)
    if args.negative_child:
        if not all((args.runner_uid, args.runner_gid)):
            emit("ROUTE_B_MECHANISM_DEFECT", "YES")
            emit("MECHANISM_DETAIL", "FAILURE_CONTROL_ARGUMENTS_INCOMPLETE")
            return 91
        return run_negative_child_cli(args)
    if args.namespace_process_check:
        try:
            return namespace_process_check(args.namespace_process_check)
        except HarnessFailure as error:
            emit("FAILURE_CONTROL_NAMESPACE_PROCESS_CHECK", "HOLD")
            emit("TEARDOWN_DETAIL", error.detail)
            return 92
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
