#!/usr/bin/env python3
import ast
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import stat
import struct
import subprocess
import sys
import tempfile


HOSTED_POLICY_PATH = Path("/etc/swooshz/s8-broker-v1.json")
HOSTED_PRIVATE_ROOT = Path("/var/lib/swooshz/s8")
HOSTED_LAUNCHER = Path("/usr/local/libexec/swooshz-s8/s8-sandbox")
HOSTED_BROKER = Path("/usr/local/libexec/swooshz-s8/s8-sandbox-broker")
HOSTED_RUNNER = Path("/usr/local/libexec/swooshz-s8/s8-process-runner")
HOSTED_VALIDATOR = Path("/usr/local/libexec/swooshz-s8/s8-native-validator")
HOSTED_SUDOERS = Path("/etc/sudoers.d/swooshz-s8-broker")
HOSTED_SERVICE = Path("/etc/systemd/system/swooshz-s8-broker-recover.service")
HOSTED_TIMER = Path("/etc/systemd/system/swooshz-s8-broker-recover.timer")
HOSTED_OPT = Path("/opt")
HOSTED_RUNTIME = Path("/opt/blender")
HOSTED_WRITER_ROOT = Path("/opt/swooshz")
HOSTED_LEDGER_NAME = "s8-broker-deployment.ledger"


class HostedDeploymentFailure(RuntimeError):
    pass


def hosted_run(args, label, *, cwd=None, log_path=None):
    result = subprocess.run(args, cwd=cwd, check=False, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    if log_path is not None:
        Path(log_path).write_bytes(result.stdout)
    if result.returncode != 0:
        detail = result.stdout.decode("utf-8", errors="replace")[-12000:]
        raise HostedDeploymentFailure(label + ("\n" + detail if detail else ""))
    return result.stdout.decode("utf-8", errors="strict")


def hosted_sudo(*args, label="HOSTED_SUDO_COMMAND_FAILED"):
    return hosted_run(["/usr/bin/sudo", "-n", *args], label)


def hosted_canonical(value):
    return json.dumps(value, ensure_ascii=True, separators=(",", ":")).encode("ascii")


HOSTED_PATH_STATE_SCRIPT = r'''
import hashlib
import json
import os
import stat
import sys

operation, path = sys.argv[1:]
if operation not in ("state", "digest") or not path.startswith("/") or ".." in path.split("/"):
    raise SystemExit("HOSTED_PATH_PROBE_ARGUMENT_INVALID")
parts = [part for part in path.split("/") if part]
if not parts:
    raise SystemExit("HOSTED_PATH_PROBE_ROOT_INVALID")
directory = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
try:
    try:
        for part in parts[:-1]:
            next_directory = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=directory)
            os.close(directory)
            directory = next_directory
        metadata = os.stat(parts[-1], dir_fd=directory, follow_symlinks=False)
    except FileNotFoundError:
        if operation == "digest":
            raise
        print(json.dumps({"state": "absent"}, separators=(",", ":")))
        raise SystemExit(0)
    kind = "regular" if stat.S_ISREG(metadata.st_mode) else "directory" if stat.S_ISDIR(metadata.st_mode) else "symlink" if stat.S_ISLNK(metadata.st_mode) else "other"
    result = {"state": "present", "kind": kind, "device": metadata.st_dev, "inode": metadata.st_ino, "uid": metadata.st_uid, "gid": metadata.st_gid, "mode": stat.S_IMODE(metadata.st_mode), "nlink": metadata.st_nlink}
    if operation == "digest":
        if kind != "regular":
            raise SystemExit("HOSTED_PATH_PROBE_NOT_REGULAR")
        descriptor = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=directory)
        try:
            opened = os.fstat(descriptor)
            if (opened.st_dev, opened.st_ino, opened.st_mode, opened.st_uid, opened.st_gid, opened.st_nlink) != (metadata.st_dev, metadata.st_ino, metadata.st_mode, metadata.st_uid, metadata.st_gid, metadata.st_nlink):
                raise SystemExit("HOSTED_PATH_PROBE_IDENTITY_CHANGED")
            digest = hashlib.sha256()
            while True:
                block = os.read(descriptor, 1024 * 1024)
                if not block:
                    break
                digest.update(block)
            after = os.stat(parts[-1], dir_fd=directory, follow_symlinks=False)
            if (after.st_dev, after.st_ino, after.st_mode, after.st_uid, after.st_gid, after.st_nlink) != (metadata.st_dev, metadata.st_ino, metadata.st_mode, metadata.st_uid, metadata.st_gid, metadata.st_nlink):
                raise SystemExit("HOSTED_PATH_PROBE_IDENTITY_CHANGED")
            result["sha256"] = digest.hexdigest()
        finally:
            os.close(descriptor)
    print(json.dumps(result, separators=(",", ":")))
finally:
    os.close(directory)
'''


HOSTED_JOURNAL_CLEANUP_SCRIPT = r'''
import hashlib
import json
import os
import re
import stat
import sys

expected_path, expected_device, expected_inode = sys.argv[1:]
if expected_path != "/var/lib/swooshz/s8/.journal" or not expected_device.isdecimal() or not expected_inode.isdecimal():
    raise SystemExit("HOSTED_JOURNAL_CLEANUP_ARGUMENT_INVALID")
directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
parent = os.open("/", directory_flags)
journal = -1
try:
    for part in ("var", "lib", "swooshz", "s8"):
        child = os.open(part, directory_flags, dir_fd=parent)
        os.close(parent)
        parent = child
    parent_state = os.fstat(parent)
    if (parent_state.st_uid, parent_state.st_gid, stat.S_IMODE(parent_state.st_mode)) != (0, 0, 0o710):
        raise SystemExit("HOSTED_JOURNAL_PARENT_IDENTITY_INVALID")
    journal = os.open(".journal", directory_flags, dir_fd=parent)
    journal_state = os.fstat(journal)
    if (journal_state.st_dev, journal_state.st_ino, journal_state.st_uid, journal_state.st_gid, stat.S_IMODE(journal_state.st_mode)) != (int(expected_device), int(expected_inode), 0, 0, 0o700):
        raise SystemExit("HOSTED_JOURNAL_IDENTITY_CHANGED")

    entries = []
    for name in sorted(os.listdir(journal)):
        if name != "lock" and not re.fullmatch(r"[0-9a-f]{32}\.json", name):
            raise SystemExit("HOSTED_JOURNAL_UNEXPECTED_CONTENT")
        before = os.stat(name, dir_fd=journal, follow_symlinks=False)
        identity = (before.st_dev, before.st_ino, before.st_mode, before.st_uid, before.st_gid, before.st_nlink, before.st_size)
        if not stat.S_ISREG(before.st_mode) or (before.st_uid, before.st_gid, stat.S_IMODE(before.st_mode), before.st_nlink) != (0, 0, 0o600, 1) or before.st_size > 16384:
            raise SystemExit("HOSTED_JOURNAL_ENTRY_IDENTITY_INVALID")
        descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=journal)
        try:
            opened = os.fstat(descriptor)
            if (opened.st_dev, opened.st_ino, opened.st_mode, opened.st_uid, opened.st_gid, opened.st_nlink, opened.st_size) != identity:
                raise SystemExit("HOSTED_JOURNAL_ENTRY_IDENTITY_CHANGED")
            chunks = []
            total = 0
            while True:
                block = os.read(descriptor, min(4096, 16385 - total))
                if not block:
                    break
                chunks.append(block)
                total += len(block)
                if total > 16384:
                    raise SystemExit("HOSTED_JOURNAL_ENTRY_OVERSIZE")
            content = b"".join(chunks)
            after = os.stat(name, dir_fd=journal, follow_symlinks=False)
            if (after.st_dev, after.st_ino, after.st_mode, after.st_uid, after.st_gid, after.st_nlink, after.st_size) != identity:
                raise SystemExit("HOSTED_JOURNAL_ENTRY_IDENTITY_CHANGED")
        finally:
            os.close(descriptor)

        if name == "lock":
            if content:
                raise SystemExit("HOSTED_JOURNAL_LOCK_CONTENT_INVALID")
        else:
            try:
                record = json.loads(content.decode("ascii"))
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                raise SystemExit("HOSTED_JOURNAL_RECORD_INVALID") from error
            if not isinstance(record, dict) or not content.endswith(b"\n"):
                raise SystemExit("HOSTED_JOURNAL_RECORD_INVALID")
            canonical = json.dumps(record, ensure_ascii=True, separators=(",", ":")).encode("ascii") + b"\n"
            checksum = record.get("recordSha256")
            preimage = dict(record)
            preimage.pop("recordSha256", None)
            checksum_preimage = json.dumps(preimage, ensure_ascii=True, separators=(",", ":")).encode("ascii") + b"\n"
            if canonical != content or not isinstance(checksum, str) or not re.fullmatch(r"[0-9a-f]{64}", checksum) or hashlib.sha256(checksum_preimage).hexdigest() != checksum:
                raise SystemExit("HOSTED_JOURNAL_RECORD_CHECKSUM_INVALID")
            leaf = record.get("leaf")
            cleanup = record.get("cleanup")
            if (
                record.get("schemaVersion") != "s8-sandbox-broker-journal-v1"
                or record.get("protocolVersion") != "s8-sandbox-broker-v1"
                or record.get("allocationId") != name[:-5]
                or record.get("operation") not in {"WRITER", "VALIDATOR"}
                or record.get("basename") != "s8-" + name[:-5]
                or record.get("state") != "ABSENT"
                or not isinstance(leaf, dict)
                or leaf.get("state") != "ABSENT"
                or not isinstance(cleanup, dict)
                or cleanup.get("state") != "ABSENT"
            ):
                raise SystemExit("HOSTED_JOURNAL_RECORD_NOT_TERMINAL")
            try:
                os.stat(record["basename"], dir_fd=parent, follow_symlinks=False)
            except FileNotFoundError:
                pass
            else:
                raise SystemExit("HOSTED_JOURNAL_ALLOCATION_REMAINS")
        entries.append((name, identity))

    for name, identity in entries:
        current = os.stat(name, dir_fd=journal, follow_symlinks=False)
        if (current.st_dev, current.st_ino, current.st_mode, current.st_uid, current.st_gid, current.st_nlink, current.st_size) != identity:
            raise SystemExit("HOSTED_JOURNAL_ENTRY_IDENTITY_CHANGED")
        os.unlink(name, dir_fd=journal)
    os.fsync(journal)
    if os.listdir(journal):
        raise SystemExit("HOSTED_JOURNAL_UNEXPECTED_CONTENT")
    os.close(journal)
    journal = -1
    os.rmdir(".journal", dir_fd=parent)
    os.fsync(parent)
finally:
    if journal >= 0:
        os.close(journal)
    os.close(parent)
print("HOSTED_BROKER_JOURNAL_CLEANUP=PASS")
'''


def hosted_protected_state(path, *, digest=False):
    path = Path(path)
    if not path.is_absolute() or ".." in path.parts:
        raise HostedDeploymentFailure("HOSTED_PATH_PROBE_ARGUMENT_INVALID")
    output = hosted_sudo("/usr/bin/python3", "-c", HOSTED_PATH_STATE_SCRIPT, "digest" if digest else "state", str(path), label="HOSTED_PATH_PROBE_FAILED:" + str(path))
    try:
        state = json.loads(output)
    except (ValueError, TypeError) as error:
        raise HostedDeploymentFailure("HOSTED_PATH_PROBE_OUTPUT_INVALID:" + str(path)) from error
    if state == {"state": "absent"} and not digest:
        return None
    keys = {"state", "kind", "device", "inode", "uid", "gid", "mode", "nlink"} | ({"sha256"} if digest else set())
    if not isinstance(state, dict) or set(state) != keys or state["state"] != "present" or state["kind"] not in {"regular", "directory", "symlink", "other"}:
        raise HostedDeploymentFailure("HOSTED_PATH_PROBE_OUTPUT_INVALID:" + str(path))
    if any(type(state[key]) is not int or state[key] < 0 for key in ("device", "inode", "uid", "gid", "mode", "nlink")) or state["mode"] > 0o7777 or state["nlink"] == 0:
        raise HostedDeploymentFailure("HOSTED_PATH_PROBE_OUTPUT_INVALID:" + str(path))
    if digest and (state["kind"] != "regular" or not isinstance(state["sha256"], str) or not re.fullmatch(r"[0-9a-f]{64}", state["sha256"])):
        raise HostedDeploymentFailure("HOSTED_PATH_PROBE_OUTPUT_INVALID:" + str(path))
    return state


def hosted_identity(state):
    return f'{state["device"]}:{state["inode"]}:{state["uid"]}:{state["gid"]}:{state["mode"]:o}'


def hosted_ledger(temp_root):
    return Path(temp_root) / HOSTED_LEDGER_NAME


def hosted_append_ledger(temp_root, row):
    path = hosted_ledger(temp_root)
    with path.open("a", encoding="ascii", newline="\n") as stream:
        stream.write(json.dumps(row, ensure_ascii=True, separators=(",", ":")) + "\n")


def hosted_record_directory(temp_root, path):
    state = hosted_protected_state(path)
    if state is None or state["kind"] != "directory" or (state["uid"], state["gid"]) != (0, 0):
        raise HostedDeploymentFailure("HOSTED_DIRECTORY_IDENTITY_INVALID:" + str(path))
    hosted_append_ledger(temp_root, {"kind": "D", "identity": hosted_identity(state), "path": str(path)})


def hosted_record_file(temp_root, path):
    state = hosted_protected_state(path, digest=True)
    if state["kind"] != "regular" or (state["uid"], state["gid"], state["nlink"]) != (0, 0, 1):
        raise HostedDeploymentFailure("HOSTED_FILE_IDENTITY_INVALID:" + str(path))
    hosted_append_ledger(temp_root, {"kind": "F", "identity": hosted_identity(state), "digest": state["sha256"], "path": str(path)})


def hosted_create_directory(temp_root, path, mode):
    if hosted_protected_state(path) is not None:
        raise HostedDeploymentFailure("HOSTED_DIRECTORY_NOT_FRESH:" + str(path))
    hosted_sudo("/usr/bin/mkdir", "-m", format(mode, "04o"), "--", str(path), label="HOSTED_DIRECTORY_CREATE_FAILED")
    try:
        hosted_record_directory(temp_root, path)
    except Exception:
        hosted_sudo("/usr/bin/rmdir", "--", str(path), label="HOSTED_UNRECORDED_DIRECTORY_CLEANUP_FAILED")
        raise


def hosted_install(temp_root, source, target, mode):
    if hosted_protected_state(target) is not None:
        raise HostedDeploymentFailure("HOSTED_FILE_NOT_FRESH:" + str(target))
    hosted_sudo("/usr/bin/install", "-o", "root", "-g", "root", "-m", format(mode, "04o"), "--", str(source), str(target), label="HOSTED_FILE_INSTALL_FAILED:" + str(target))
    try:
        hosted_record_file(temp_root, target)
    except Exception:
        hosted_sudo("/usr/bin/rm", "-f", "--", str(target), label="HOSTED_UNRECORDED_FILE_CLEANUP_FAILED")
        raise


def hosted_file_digest(path, mode):
    state = hosted_protected_state(path, digest=True)
    if (state["kind"], state["uid"], state["gid"], state["mode"], state["nlink"]) != ("regular", 0, 0, mode, 1):
        raise HostedDeploymentFailure("HOSTED_DEPLOYED_FILE_IDENTITY_INVALID:" + str(path))
    return state["sha256"]


HOSTED_ACL_ENTRY = re.compile(r"(?:(default)\s*:\s*)?(user|group|mask|other)\s*:\s*([^:]*)\s*:\s*([r-][w-][x-])(?:\s*#\s*effective\s*:\s*([r-][w-][x-]))?")


def hosted_parse_acl(text, *, default):
    entries, issues = {}, []
    if not isinstance(text, str) or len(text) > 4096:
        return entries, ["OUTPUT_INVALID_OR_OVERSIZE"]
    lines = text.splitlines()
    if len(lines) > 32:
        return entries, ["TOO_MANY_LINES"]
    for raw_line in lines:
        line = raw_line.strip()
        if not line:
            continue
        if len(line) > 256:
            issues.append("LINE_OVERSIZE")
            continue
        if re.fullmatch(r"#\s*(?:file|owner|group|flags):[^\r\n]*", line):
            continue
        match = HOSTED_ACL_ENTRY.fullmatch(line)
        if match is None:
            issues.append("MALFORMED_LINE")
            continue
        prefix, tag, qualifier, rights, effective = match.groups()
        qualifier = qualifier.strip()
        if (prefix is not None and not default) or (qualifier and (tag not in {"user", "group"} or not re.fullmatch(r"[0-9]{1,10}", qualifier))):
            issues.append("INVALID_ENTRY")
            continue
        key = tag + ":" + qualifier
        if key in entries:
            issues.append("DUPLICATE_ENTRY")
            continue
        entries[key] = (rights, effective)
    return entries, issues


def hosted_mount_entry(target):
    target = os.path.normpath(str(target))

    def decode(value):
        return re.sub(r"\\([0-7]{3})", lambda match: chr(int(match.group(1), 8)), value)

    try:
        rows = Path("/proc/self/mountinfo").read_text(encoding="ascii").splitlines()
    except (OSError, UnicodeError) as error:
        raise HostedDeploymentFailure("HOSTED_MOUNTINFO_READ_FAILED") from error
    candidates = []
    for row in rows:
        halves = row.split(" - ", 1)
        if len(halves) != 2:
            raise HostedDeploymentFailure("HOSTED_MOUNTINFO_MALFORMED")
        left, right = halves
        fields, filesystem = left.split(), right.split()
        if len(fields) < 6 or len(filesystem) < 3:
            raise HostedDeploymentFailure("HOSTED_MOUNTINFO_MALFORMED")
        mountpoint = decode(fields[4])
        if target == mountpoint or target.startswith(mountpoint.rstrip("/") + "/") or mountpoint == "/":
            candidates.append((len(mountpoint), {
                "mountId": fields[0],
                "parentId": fields[1],
                "device": fields[2],
                "root": decode(fields[3]),
                "mountpoint": mountpoint,
                "optional": fields[6:],
                "filesystem": filesystem[0],
                "source": decode(filesystem[1]),
            }))
    if not candidates:
        raise HostedDeploymentFailure("HOSTED_MOUNTINFO_TARGET_MISSING")
    return max(candidates, key=lambda item: item[0])[1]


def hosted_verify_opt_namespace(runner_uid):
    outer_mnt = os.environ.get("S8_NAMESPACE_OUTER_MNT", "")
    inner_mnt = os.environ.get("S8_NAMESPACE_INNER_MNT", "")
    outer_user = os.environ.get("S8_NAMESPACE_OUTER_USER", "")
    inner_user = os.environ.get("S8_NAMESPACE_INNER_USER", "")
    outer_pid = os.environ.get("S8_NAMESPACE_OUTER_PID", "")
    inner_pid = os.environ.get("S8_NAMESPACE_INNER_PID", "")
    if (
        os.environ.get("S8_MOUNT_NAMESPACE_ACTIVE") != "1"
        or os.geteuid() != int(runner_uid)
        or os.readlink("/proc/self/ns/mnt") != inner_mnt
        or not outer_mnt or not inner_mnt or outer_mnt == inner_mnt
        or not outer_user or outer_user != inner_user or os.readlink("/proc/self/ns/user") != inner_user
        or not outer_pid or outer_pid != inner_pid or os.readlink("/proc/self/ns/pid") != inner_pid
        or os.environ.get("S8_NAMESPACE_TOOLCHAIN_CONTINUITY") != "PASS"
        or not re.fullmatch(r"[0-9a-f]{64}", os.environ.get("S8_NAMESPACE_TOOLCHAIN_NODE_SHA256", ""))
    ):
        raise HostedDeploymentFailure("HOSTED_OPT_NAMESPACE_BINDING_INVALID")
    expected_mount = os.environ.get("S8_NAMESPACE_INNER_OPT_MOUNT_ID", "")
    outer_mount = os.environ.get("S8_NAMESPACE_OUTER_OPT_MOUNT_ID", "")
    outer_device = os.environ.get("S8_NAMESPACE_OUTER_OPT_DEVICE", "")
    if not re.fullmatch(r"[1-9][0-9]*", expected_mount) or not re.fullmatch(r"[1-9][0-9]*", outer_mount) or not re.fullmatch(r"[0-9]+", outer_device):
        raise HostedDeploymentFailure("HOSTED_OPT_MOUNT_BINDING_INVALID")
    state = hosted_protected_state(HOSTED_OPT)
    mount = hosted_mount_entry(HOSTED_OPT)
    filesystem = hosted_run(["/usr/bin/stat", "-f", "-c", "%T", "--", str(HOSTED_OPT)], "HOSTED_OPT_FILESYSTEM_PROBE_FAILED").strip()
    access_text = hosted_run(["/usr/bin/getfacl", "--numeric", "--omit-header", "--absolute-names", "--physical", "--all-effective", "--access", "--", str(HOSTED_OPT)], "HOSTED_OPT_ACCESS_ACL_READ_FAILED")
    default_text = hosted_run(["/usr/bin/getfacl", "--numeric", "--omit-header", "--absolute-names", "--physical", "--all-effective", "--default", "--", str(HOSTED_OPT)], "HOSTED_OPT_DEFAULT_ACL_READ_FAILED")
    access, access_issues = hosted_parse_acl(access_text, default=False)
    defaults, default_issues = hosted_parse_acl(default_text, default=True)
    expected_access = {"user:": "rwx", "group:": "r-x", "other:": "r-x"}
    actual_access = {key: rights for key, (rights, _) in access.items()}
    if (
        state is None or (state["kind"], state["uid"], state["gid"], state["mode"]) != ("directory", 0, 0, 0o755)
        or state["device"] == int(outer_device) or mount["mountId"] != expected_mount
        or mount["mountId"] == outer_mount or mount["filesystem"] != "tmpfs" or filesystem != "tmpfs"
        or access_issues or default_issues or actual_access != expected_access or defaults
    ):
        raise HostedDeploymentFailure("HOSTED_OPT_TRUST_CONTRACT_INVALID")
    print("HOSTED_OPT_MOUNT_ID=" + mount["mountId"])
    print("HOSTED_OPT_MOUNT_DEVICE=" + mount["device"])
    print("HOSTED_OPT_MOUNT_ROOT=" + mount["root"])
    print("HOSTED_OPT_MOUNT_SOURCE=" + mount["source"])
    print("HOSTED_OPT_DEVICE=" + str(state["device"]))
    print("HOSTED_OPT_INODE=" + str(state["inode"]))
    print("HOSTED_OPT_IDENTITY=root:root:0755")
    print("HOSTED_OPT_ACCESS_ACL=" + ",".join(key + ":" + rights for key, (rights, _) in sorted(access.items())))
    print("HOSTED_OPT_DEFAULT_ACL=ABSENT")
    print("HOSTED_TOOLCHAIN_CONTINUITY=PASS")
    print("HOSTED_OPT_NAMESPACE=PASS")


def hosted_verify_opt_product_paths():
    opt_state = hosted_protected_state(HOSTED_OPT)
    opt_mount = hosted_mount_entry(HOSTED_OPT)
    for label, path in (("BLENDER", HOSTED_RUNTIME), ("SWOOSHZ", HOSTED_WRITER_ROOT)):
        state = hosted_protected_state(path)
        mount = hosted_mount_entry(path)
        if (
            state is None or (state["kind"], state["uid"], state["gid"], state["mode"]) != ("directory", 0, 0, 0o755)
            or state["device"] != opt_state["device"] or mount["mountId"] != opt_mount["mountId"]
        ):
            raise HostedDeploymentFailure("HOSTED_PRODUCT_PATH_NOT_ON_INNER_OPT:" + label)
        print("HOSTED_" + label + "_INNER_OPT_MOUNT_ID=" + mount["mountId"])
        print("HOSTED_" + label + "_INNER_OPT_DEVICE=" + str(state["device"]))
    print("HOSTED_PRODUCT_PATHS_ON_INNER_OPT=PASS")


def hosted_acl_effective(rights, mask):
    return "".join(permission if permission == mask[index] else "-" for index, permission in enumerate(rights))


def hosted_acl_diagnostic(access, defaults, state, issues, effective_mismatch, reason, *, identity_match):
    def normalized(entries):
        return [key + ":" + rights + ("#effective:" + effective if effective is not None else "") for key, (rights, effective) in sorted(entries.items())]

    diagnostic = {
        "reason": reason,
        "access": normalized(access),
        "default": normalized(defaults),
        "uid": state["uid"] if state is not None else "UNAVAILABLE",
        "gid": state["gid"] if state is not None else "UNAVAILABLE",
        "mode": format(state["mode"], "04o") if state is not None else "UNAVAILABLE",
        "kind": state["kind"] if state is not None else "UNAVAILABLE",
        "identityMatch": identity_match,
        "effectiveMismatch": sorted(set(effective_mismatch))[:32],
        "parseIssues": sorted(set(issues))[:8],
    }
    return json.dumps(diagnostic, ensure_ascii=True, sort_keys=True, separators=(",", ":"))


def hosted_verify_acl_semantics(access_text, default_text, runner_uid, before, after):
    access, access_issues = hosted_parse_acl(access_text, default=False)
    defaults, default_issues = hosted_parse_acl(default_text, default=True)
    expected = {"user:": "rwx", "user:" + str(runner_uid): "--x", "group:": "---", "mask:": "--x", "other:": "---"}
    access_rights = {key: rights for key, (rights, _) in access.items()}
    mask = access_rights.get("mask:")
    effective_mismatch = []
    for key, (rights, reported) in access.items():
        masked = key.startswith("group:") or (key.startswith("user:") and key != "user:")
        derived = hosted_acl_effective(rights, mask) if masked and mask is not None else rights
        if reported is not None and reported != derived:
            effective_mismatch.append(key + ":REPORTED")
        if key in expected and derived != expected[key]:
            effective_mismatch.append(key + ":INTENDED")
    identity_match = (
        before is not None and after is not None
        and (before["device"], before["inode"]) == (after["device"], after["inode"])
        and all((state["kind"], state["uid"], state["gid"], state["mode"]) == ("directory", 0, 0, 0o710) for state in (before, after))
    )
    if access_issues or default_issues or access_rights != expected or defaults or effective_mismatch or not identity_match:
        diagnostic = hosted_acl_diagnostic(access, defaults, after, access_issues + default_issues, effective_mismatch, "SEMANTIC_MISMATCH", identity_match=identity_match)
        raise HostedDeploymentFailure("HOSTED_PRIVATE_ROOT_ACL_INVALID:" + diagnostic)
    return access, defaults


def hosted_verify_private_root_acl(runner_uid):
    try:
        before = hosted_protected_state(HOSTED_PRIVATE_ROOT)
    except HostedDeploymentFailure as error:
        diagnostic = hosted_acl_diagnostic({}, {}, None, ["PRE_PROBE_FAILED"], [], "PRIVILEGED_IDENTITY_READ_FAILED", identity_match=False)
        raise HostedDeploymentFailure("HOSTED_PRIVATE_ROOT_ACL_IDENTITY_READ_FAILED:" + diagnostic) from error
    if before is None or (before["kind"], before["uid"], before["gid"], before["mode"]) != ("directory", 0, 0, 0o710):
        diagnostic = hosted_acl_diagnostic({}, {}, before, [], [], "PRE_APPLY_IDENTITY_INVALID", identity_match=False)
        raise HostedDeploymentFailure("HOSTED_PRIVATE_ROOT_ACL_INVALID:" + diagnostic)
    acl = f"u::rwx,u:{runner_uid}:--x,g::---,m::--x,o::---"
    try:
        hosted_sudo("/usr/bin/setfacl", "--no-mask", "--set", acl, "--", str(HOSTED_PRIVATE_ROOT), label="HOSTED_PRIVATE_ROOT_ACL_CREATE_FAILED")
    except HostedDeploymentFailure as error:
        diagnostic = hosted_acl_diagnostic({}, {}, before, ["SETFACL_FAILED"], [], "PRIVILEGED_WRITE_FAILED", identity_match=False)
        raise HostedDeploymentFailure("HOSTED_PRIVATE_ROOT_ACL_CREATE_FAILED:" + diagnostic) from error
    try:
        access_text = hosted_sudo("/usr/bin/getfacl", "--numeric", "--omit-header", "--absolute-names", "--physical", "--all-effective", "--access", "--", str(HOSTED_PRIVATE_ROOT), label="HOSTED_PRIVATE_ROOT_ACL_ACCESS_READ_FAILED")
    except HostedDeploymentFailure as error:
        diagnostic = hosted_acl_diagnostic({}, {}, before, ["ACCESS_READ_FAILED"], [], "PRIVILEGED_READ_FAILED", identity_match=False)
        raise HostedDeploymentFailure("HOSTED_PRIVATE_ROOT_ACL_READ_FAILED:" + diagnostic) from error
    try:
        default_text = hosted_sudo("/usr/bin/getfacl", "--numeric", "--omit-header", "--absolute-names", "--physical", "--all-effective", "--default", "--", str(HOSTED_PRIVATE_ROOT), label="HOSTED_PRIVATE_ROOT_ACL_DEFAULT_READ_FAILED")
    except HostedDeploymentFailure as error:
        access, issues = hosted_parse_acl(access_text, default=False)
        diagnostic = hosted_acl_diagnostic(access, {}, before, issues + ["DEFAULT_READ_FAILED"], [], "PRIVILEGED_READ_FAILED", identity_match=False)
        raise HostedDeploymentFailure("HOSTED_PRIVATE_ROOT_ACL_READ_FAILED:" + diagnostic) from error
    try:
        after = hosted_protected_state(HOSTED_PRIVATE_ROOT)
    except HostedDeploymentFailure as error:
        access, access_issues = hosted_parse_acl(access_text, default=False)
        defaults, default_issues = hosted_parse_acl(default_text, default=True)
        diagnostic = hosted_acl_diagnostic(access, defaults, None, access_issues + default_issues + ["POST_PROBE_FAILED"], [], "PRIVILEGED_IDENTITY_READ_FAILED", identity_match=False)
        raise HostedDeploymentFailure("HOSTED_PRIVATE_ROOT_ACL_IDENTITY_READ_FAILED:" + diagnostic) from error
    access, defaults = hosted_verify_acl_semantics(access_text, default_text, runner_uid, before, after)
    return {"identity": after, "access": access, "defaults": defaults}


def hosted_policy(temp_root, runner_uid, runner_gid):
    root_state = hosted_protected_state(HOSTED_PRIVATE_ROOT)
    if root_state is None or (root_state["kind"], root_state["uid"], root_state["gid"], root_state["mode"]) != ("directory", 0, 0, 0o710):
        raise HostedDeploymentFailure("HOSTED_PRIVATE_ROOT_IDENTITY_INVALID")
    config = {
        "blenderRuntimeRoot": "/opt/blender",
        "blenderExecutable": "/opt/blender/blender",
        "writerScript": "/opt/swooshz/writer.py",
        "privateWorkRoot": str(HOSTED_PRIVATE_ROOT),
        "processRunnerExecutable": str(HOSTED_RUNNER),
        "sandboxExecutable": str(HOSTED_LAUNCHER),
        "nativeValidatorExecutable": str(HOSTED_VALIDATOR),
        "blenderExecutableSha256": hosted_file_digest(HOSTED_RUNTIME / "blender", 0o755),
    }
    policy = {
        "schemaVersion": "s8-sandbox-broker-policy-v1",
        "protocolVersion": "s8-sandbox-broker-v1",
        "hostUid": runner_uid,
        "hostGid": runner_gid,
        "config": config,
        "privateRootDevice": str(root_state["device"]),
        "privateRootInode": str(root_state["inode"]),
        "launcherSha256": hosted_file_digest(HOSTED_LAUNCHER, 0o755),
        "brokerSha256": hosted_file_digest(HOSTED_BROKER, 0o755),
        "bubblewrapSha256": hosted_file_digest(Path("/usr/bin/bwrap"), 0o755),
        "runnerSha256": hosted_file_digest(HOSTED_RUNNER, 0o755),
        "validatorSha256": hosted_file_digest(HOSTED_VALIDATOR, 0o755),
        "writerSha256": hosted_file_digest(HOSTED_WRITER_ROOT / "writer.py", 0o644),
        "privateExporterSha256": hosted_file_digest(HOSTED_WRITER_ROOT / "export_fbx_bin.py", 0o644),
        "patchManifestSha256": hosted_file_digest(HOSTED_WRITER_ROOT / "patch-manifest.json", 0o644),
    }
    policy_h = hashlib.sha256(hosted_canonical(policy)).hexdigest()
    config["sandboxPolicySha256"] = policy_h
    policy_bytes = hosted_canonical(policy)
    config_q = hashlib.sha256(hosted_canonical(config)).hexdigest()
    policy_tmp = Path(temp_root) / "s8-broker-v1.json"
    descriptor = os.open(policy_tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "wb") as output:
        output.write(policy_bytes)
        output.flush()
        os.fsync(output.fileno())
    reconstructed = json.loads(policy_bytes)
    preimage = json.loads(policy_bytes)
    del preimage["config"]["sandboxPolicySha256"]
    if hosted_canonical(reconstructed) != policy_bytes or hashlib.sha256(hosted_canonical(preimage)).hexdigest() != policy_h or hashlib.sha256(hosted_canonical(reconstructed["config"])).hexdigest() != config_q:
        raise HostedDeploymentFailure("HOSTED_POLICY_CANONICAL_ROUNDTRIP_FAILED")
    return policy_tmp, policy_h, config_q, hashlib.sha256(policy_bytes).hexdigest()


def hosted_load_ledger(temp_root):
    path = hosted_ledger(temp_root)
    if not path.exists() and not path.is_symlink():
        print("BROKER_DEPLOYMENT_CLEANUP=PASS_NO_LEDGER")
        return None
    metadata = path.lstat()
    if not stat.S_ISREG(metadata.st_mode) or (metadata.st_uid, metadata.st_gid, stat.S_IMODE(metadata.st_mode)) != (os.getuid(), os.getgid(), 0o600):
        raise HostedDeploymentFailure("HOSTED_LEDGER_IDENTITY_INVALID")
    rows = [json.loads(line) for line in path.read_text(encoding="ascii").splitlines()]
    allowed_dirs = {
        "/usr/local/libexec", "/usr/local/libexec/swooshz-s8", "/var/lib/swooshz", "/var/lib/swooshz/s8",
        "/etc/swooshz", "/opt/blender", "/opt/swooshz",
    }
    allowed_files = {
        "/etc/swooshz/s8-broker-v1.json", "/etc/sudoers.d/swooshz-s8-broker",
        "/etc/systemd/system/swooshz-s8-broker-recover.service", "/etc/systemd/system/swooshz-s8-broker-recover.timer",
        "/usr/local/libexec/swooshz-s8/s8-sandbox", "/usr/local/libexec/swooshz-s8/s8-sandbox-broker",
        "/usr/local/libexec/swooshz-s8/s8-process-runner", "/usr/local/libexec/swooshz-s8/s8-native-validator",
        "/opt/swooshz/writer.py", "/opt/swooshz/export_fbx_bin.py", "/opt/swooshz/patch-manifest.json",
    }
    seen = set()
    for row in rows:
        if not isinstance(row, dict) or row.get("kind") not in {"D", "F"} or not isinstance(row.get("path"), str):
            raise HostedDeploymentFailure("HOSTED_LEDGER_ROW_INVALID")
        kind, target = row["kind"], row["path"]
        if target in seen or (kind == "D" and target not in allowed_dirs) or (kind == "F" and target not in allowed_files):
            raise HostedDeploymentFailure("HOSTED_LEDGER_PATH_INVALID")
        if not isinstance(row.get("identity"), str) or not re.fullmatch(r"[0-9]+:[0-9]+:[0-9]+:[0-9]+:[0-7]+", row["identity"]):
            raise HostedDeploymentFailure("HOSTED_LEDGER_IDENTITY_INVALID")
        if kind == "F" and (not isinstance(row.get("digest"), str) or not re.fullmatch(r"[0-9a-f]{64}", row["digest"])):
            raise HostedDeploymentFailure("HOSTED_LEDGER_DIGEST_INVALID")
        seen.add(target)
    return rows


def hosted_cleanup(temp_root):
    temp_root = Path(temp_root)
    rows = hosted_load_ledger(temp_root)
    if rows is None:
        return
    journal = HOSTED_PRIVATE_ROOT / ".journal"
    journal_state = hosted_protected_state(journal)
    broker_state = hosted_protected_state(HOSTED_BROKER)
    policy_state = hosted_protected_state(HOSTED_POLICY_PATH)
    if broker_state is not None and broker_state["kind"] == "regular" and policy_state is not None and policy_state["kind"] == "regular":
        hosted_sudo(str(HOSTED_BROKER), "--recover-v1", label="HOSTED_BROKER_RECOVERY_FAILED")
        print("BROKER_RECOVERY_CLEANUP=PASS")
    elif journal_state is not None:
        raise HostedDeploymentFailure("HOSTED_RECOVERY_INPUTS_INVALID")
    if journal_state is not None:
        if broker_state is None or broker_state["kind"] != "regular" or policy_state is None or policy_state["kind"] != "regular":
            raise HostedDeploymentFailure("HOSTED_RECOVERY_INPUTS_INVALID")
        journal_state = hosted_protected_state(journal)
        if journal_state is None or (journal_state["kind"], journal_state["uid"], journal_state["gid"], journal_state["mode"]) != ("directory", 0, 0, 0o700):
            raise HostedDeploymentFailure("HOSTED_JOURNAL_IDENTITY_INVALID")
        hosted_sudo(
            "/usr/bin/python3", "-c", HOSTED_JOURNAL_CLEANUP_SCRIPT, str(journal),
            str(journal_state["device"]), str(journal_state["inode"]), label="HOSTED_JOURNAL_CLEANUP_FAILED",
        )
        if hosted_protected_state(journal) is not None:
            raise HostedDeploymentFailure("HOSTED_JOURNAL_REMAINS")

    for row in reversed(rows):
        target = Path(row["path"])
        if row["kind"] != "F":
            continue
        state = hosted_protected_state(target, digest=True)
        if state["kind"] != "regular" or hosted_identity(state) != row["identity"]:
            raise HostedDeploymentFailure("HOSTED_FILE_CLEANUP_IDENTITY_INVALID:" + str(target))
        if state["sha256"] != row["digest"]:
            raise HostedDeploymentFailure("HOSTED_FILE_CLEANUP_HASH_INVALID:" + str(target))
        hosted_sudo("/usr/bin/rm", "-f", "--", str(target), label="HOSTED_FILE_CLEANUP_FAILED")
        if hosted_protected_state(target) is not None:
            raise HostedDeploymentFailure("HOSTED_FILE_REMAINS:" + str(target))

    mounts = hosted_run(["/usr/bin/findmnt", "--noheadings", "--raw", "--output", "TARGET"], "HOSTED_MOUNT_INSPECTION_FAILED").splitlines()
    for row in reversed(rows):
        target = Path(row["path"])
        if row["kind"] != "D":
            continue
        state = hosted_protected_state(target)
        if state is None or state["kind"] != "directory" or hosted_identity(state) != row["identity"]:
            raise HostedDeploymentFailure("HOSTED_DIRECTORY_CLEANUP_IDENTITY_INVALID:" + str(target))
        if any(mount == str(target) or mount.startswith(str(target).rstrip("/") + "/") for mount in mounts):
            raise HostedDeploymentFailure("HOSTED_NESTED_MOUNT_REFUSED:" + str(target))
        if str(target) == "/opt/blender":
            hosted_sudo("/usr/bin/rm", "-rf", "--", str(target), label="HOSTED_RUNTIME_CLEANUP_FAILED")
        else:
            hosted_sudo("/usr/bin/rmdir", "--", str(target), label="HOSTED_DIRECTORY_CLEANUP_FAILED")
        if hosted_protected_state(target) is not None:
            raise HostedDeploymentFailure("HOSTED_DIRECTORY_REMAINS:" + str(target))
    hosted_ledger(temp_root).unlink()
    print("BROKER_DEPLOYMENT_CLEANUP=PASS")
    print("PRODUCTION_DEPLOYMENT_ABSENT=YES")


def hosted_deploy(carrier, temp_root, runner_uid, runner_gid):
    carrier, temp_root = Path(carrier), Path(temp_root)
    carrier_meta = carrier.lstat() if carrier.exists() or carrier.is_symlink() else None
    if not re.fullmatch(r"/s8-ci-carrier-[0-9]+\.[0-9]+", str(carrier)) or carrier_meta is None or not stat.S_ISDIR(carrier_meta.st_mode) or carrier.is_symlink() or (carrier_meta.st_uid, carrier_meta.st_gid, stat.S_IMODE(carrier_meta.st_mode)) != (0, 0, 0o755):
        raise HostedDeploymentFailure("HOSTED_CARRIER_ADMISSION_FAILED")
    workspace = Path(os.environ.get("GITHUB_WORKSPACE", ""))
    if not workspace.is_dir() or workspace.is_symlink() or workspace.resolve() != Path(__file__).resolve().parents[3]:
        raise HostedDeploymentFailure("HOSTED_WORKSPACE_IDENTITY_INVALID")
    temp_meta = temp_root.lstat() if temp_root.exists() or temp_root.is_symlink() else None
    if temp_meta is None or not stat.S_ISDIR(temp_meta.st_mode) or temp_root.is_symlink() or (temp_meta.st_uid, temp_meta.st_gid, stat.S_IMODE(temp_meta.st_mode)) != (os.getuid(), os.getgid(), 0o700):
        raise HostedDeploymentFailure("HOSTED_TEMP_ROOT_IDENTITY_INVALID")
    if not re.fullmatch(r"[1-9][0-9]*", runner_uid) or not re.fullmatch(r"[1-9][0-9]*", runner_gid) or (int(runner_uid), int(runner_gid)) != (os.getuid(), os.getgid()):
        raise HostedDeploymentFailure("HOSTED_RUNNER_IDENTITY_INVALID")
    runner_name = pwd.getpwuid(os.getuid()).pw_name
    if not re.fullmatch(r"[a-z_][a-z0-9_-]*\$?", runner_name):
        raise HostedDeploymentFailure("HOSTED_RUNNER_NAME_INVALID")
    hosted_verify_opt_namespace(runner_uid)
    ledger = hosted_ledger(temp_root)
    if ledger.exists() or ledger.is_symlink():
        raise HostedDeploymentFailure("HOSTED_LEDGER_PREEXISTENCE")
    descriptor = os.open(ledger, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    os.close(descriptor)
    try:
        build = temp_root / "s8-broker-build"
        hosted_run(["/usr/local/bin/cmake", "-S", str(workspace / "native/s8-sandbox-broker"), "-B", str(build), "-DCMAKE_BUILD_TYPE=Release"], "BROKER_CMAKE_CONFIGURE_FAILED", log_path=temp_root / "broker-cmake-configure.log")
        hosted_run(["/usr/local/bin/cmake", "--build", str(build), "--config", "Release", "--parallel"], "BROKER_BUILD_FAILED", log_path=temp_root / "broker-build.log")
        hosted_run(["/usr/local/bin/ctest", "--test-dir", str(build), "--output-on-failure"], "BROKER_TESTS_FAILED", log_path=temp_root / "broker-ctest.log")
        broker_build = build / "s8-sandbox-broker"
        if not broker_build.is_file() or broker_build.is_symlink() or not os.access(broker_build, os.X_OK):
            raise HostedDeploymentFailure("HOSTED_BROKER_BUILD_OUTPUT_INVALID")

        absent = [Path(path) for path in (
            "/usr/local/libexec/swooshz-s8", "/etc/swooshz", "/var/lib/swooshz/s8", "/opt/blender", "/opt/swooshz",
            str(HOSTED_POLICY_PATH), str(HOSTED_SUDOERS), str(HOSTED_SERVICE), str(HOSTED_TIMER), str(HOSTED_LAUNCHER), str(HOSTED_BROKER), str(HOSTED_RUNNER), str(HOSTED_VALIDATOR),
        )]
        if any(hosted_protected_state(path) is not None for path in absent):
            raise HostedDeploymentFailure("HOSTED_DEPLOYMENT_PATH_NOT_FRESH")
        for parent in (Path("/usr/local/libexec"), Path("/var/lib/swooshz")):
            parent_state = hosted_protected_state(parent)
            if parent_state is not None:
                if (parent_state["kind"], parent_state["uid"], parent_state["gid"], parent_state["mode"]) != ("directory", 0, 0, 0o755):
                    raise HostedDeploymentFailure("HOSTED_DEPLOYMENT_PARENT_IDENTITY_INVALID:" + str(parent))
            else:
                hosted_create_directory(temp_root, parent, 0o755)
        hosted_create_directory(temp_root, Path("/usr/local/libexec/swooshz-s8"), 0o755)
        hosted_create_directory(temp_root, HOSTED_RUNTIME, 0o755)
        hosted_create_directory(temp_root, HOSTED_WRITER_ROOT, 0o755)
        hosted_create_directory(temp_root, HOSTED_PRIVATE_ROOT, 0o710)
        if hosted_protected_state(Path("/etc/swooshz")) is None:
            hosted_create_directory(temp_root, Path("/etc/swooshz"), 0o755)

        root_acl = hosted_verify_private_root_acl(runner_uid)
        root_identity = root_acl["identity"]
        print("HOSTED_PRIVATE_ROOT_OWNER_MODE=" + f"{root_identity['uid']}:{root_identity['gid']}:{root_identity['mode']:04o}")
        access = root_acl["access"]
        acl_order = ("user:", "user:" + str(runner_uid), "group:", "mask:", "other:")
        print("HOSTED_PRIVATE_ROOT_ACCESS_ACL=" + ",".join(key + ":" + access[key][0] for key in acl_order))
        print("HOSTED_PRIVATE_ROOT_DEFAULT_ACL=ABSENT")
        print("HOSTED_PRIVATE_ROOT_ACL=PASS")

        source_runtime = carrier / "runtime/blender-5.2.2-linux-x64"
        hosted_verify_opt_product_paths()
        hosted_sudo("/usr/bin/cp", "-a", "--no-dereference", "--", str(source_runtime) + "/.", str(HOSTED_RUNTIME) + "/", label="HOSTED_RUNTIME_COPY_FAILED")
        hosted_sudo("/usr/bin/chown", "-R", "--no-dereference", "root:root", "--", str(HOSTED_RUNTIME), label="HOSTED_RUNTIME_OWNER_FAILED")
        for args, label in ((["-type", "d", "-exec", "/usr/bin/chmod", "0755", "--", "{}", "+"], "HOSTED_RUNTIME_DIRECTORY_MODE_FAILED"), (["-type", "f", "-perm", "/111", "-exec", "/usr/bin/chmod", "0755", "--", "{}", "+"], "HOSTED_RUNTIME_EXECUTABLE_MODE_FAILED"), (["-type", "f", "!", "-perm", "/111", "-exec", "/usr/bin/chmod", "0644", "--", "{}", "+"], "HOSTED_RUNTIME_DATA_MODE_FAILED")):
            hosted_sudo("/usr/bin/find", "-P", str(HOSTED_RUNTIME), *args, label=label)

        hosted_install(temp_root, carrier / "native/s8-process-runner", HOSTED_RUNNER, 0o755)
        hosted_install(temp_root, carrier / "native/s8-fbx-validator", HOSTED_VALIDATOR, 0o755)
        hosted_install(temp_root, broker_build, HOSTED_BROKER, 0o755)
        hosted_install(temp_root, workspace / "native/s8-sandbox-broker/deploy/s8-sandbox", HOSTED_LAUNCHER, 0o755)
        hosted_install(temp_root, carrier / "writer/writer.py", HOSTED_WRITER_ROOT / "writer.py", 0o644)
        hosted_install(temp_root, carrier / "writer/export_fbx_bin.py", HOSTED_WRITER_ROOT / "export_fbx_bin.py", 0o644)
        hosted_install(temp_root, carrier / "writer/patch-manifest.json", HOSTED_WRITER_ROOT / "patch-manifest.json", 0o644)
        hosted_install(temp_root, workspace / "native/s8-sandbox-broker/deploy/swooshz-s8-broker-recover.service", HOSTED_SERVICE, 0o644)
        hosted_install(temp_root, workspace / "native/s8-sandbox-broker/deploy/swooshz-s8-broker-recover.timer", HOSTED_TIMER, 0o644)

        sudoers_template = workspace / "native/s8-sandbox-broker/deploy/swooshz-s8-broker.sudoers.in"
        sudoers_source = sudoers_template.read_text(encoding="ascii")
        if sudoers_source.count("@S8_HOST_USER@") != 1:
            raise HostedDeploymentFailure("HOSTED_SUDOERS_TEMPLATE_INVALID")
        sudoers_tmp = temp_root / "swooshz-s8-broker.sudoers"
        sudoers_tmp.write_text(sudoers_source.replace("@S8_HOST_USER@", runner_name), encoding="ascii")
        sudoers_tmp.chmod(0o600)
        hosted_install(temp_root, sudoers_tmp, HOSTED_SUDOERS, 0o440)
        hosted_sudo("/usr/sbin/visudo", "-c", "-f", str(HOSTED_SUDOERS), label="HOSTED_SUDOERS_VALIDATION_FAILED")

        policy_tmp, policy_h, config_q, policy_file_hash = hosted_policy(temp_root, int(runner_uid), int(runner_gid))
        hosted_install(temp_root, policy_tmp, HOSTED_POLICY_PATH, 0o600)
        if hosted_file_digest(HOSTED_POLICY_PATH, 0o600) != policy_file_hash:
            raise HostedDeploymentFailure("HOSTED_POLICY_INSTALL_HASH_MISMATCH")
        hosted_sudo(str(HOSTED_BROKER), "--recover-v1", label="HOSTED_BROKER_POLICY_ADMISSION_FAILED")
        print("BROKER_BUILD=PASS")
        print("BROKER_TESTS=PASS")
        print("HOSTED_BROKER_BUILD_WIRING=PASS")
        print("HOSTED_BROKER_DEPLOYMENT=PASS")
        print("HOSTED_PRIVATE_ROOT=PASS")
        print("HOSTED_POLICY_GENERATION=PASS")
        print("POLICY_CANONICAL_ROUNDTRIP=PASS")
        print("BROKER_RECOVER=PASS")
        print("BROKER_POLICY_ADMISSION=PASS")
        print("HOSTED_POLICY_H=" + policy_h)
        print("HOSTED_CONFIG_Q=" + config_q)
        print("HOSTED_POLICY_FILE_SHA256=" + policy_file_hash)
        print("S8_APP_PRIVATE_ROOT=" + str(HOSTED_PRIVATE_ROOT))
        print("S8_APP_SANDBOX_POLICY_SHA256=" + policy_h)
        print("S8_APP_CONFIG_SHA256=" + config_q)
        print("S8_APP_SANDBOX=" + str(HOSTED_LAUNCHER))
        print("CONFIG_DIGEST_INCLUDES_POLICY_DIGEST=YES")
    except Exception as error:
        print("HOSTED_COMBINED_BROKER_DEPLOYMENT_FAILURE=" + str(error), file=sys.stderr)
        try:
            hosted_cleanup(temp_root)
        except Exception as cleanup_error:
            print("BROKER_DEPLOYMENT_ROLLBACK=FAIL", file=sys.stderr)
            print("BROKER_DEPLOYMENT_ROLLBACK_FAILURE=" + str(cleanup_error), file=sys.stderr)
        raise


def hosted_cli():
    if len(sys.argv) < 2 or sys.argv[1] not in {"--hosted-deploy", "--hosted-cleanup"}:
        return False
    mode = sys.argv[1]
    try:
        if mode == "--hosted-deploy" and len(sys.argv) == 6:
            hosted_deploy(*sys.argv[2:])
        elif mode == "--hosted-cleanup" and len(sys.argv) == 3:
            hosted_cleanup(sys.argv[2])
        else:
            raise HostedDeploymentFailure("HOSTED_DEPLOYMENT_ARGUMENTS_INVALID")
    except Exception as error:
        print("HOSTED_COMBINED_BROKER_ERROR=" + str(error), file=sys.stderr)
        raise SystemExit(1)
    return True


if hosted_cli():
    raise SystemExit(0)

if len(sys.argv) != 3:
    raise SystemExit("BROKER_CONTRACT_ARGUMENTS_INVALID")
contract, production = sys.argv[1:]


def assert_hosted_probe_regressions():
    original_sudo = hosted_sudo
    try:
        with tempfile.TemporaryDirectory(prefix="s8-hosted-path-probe-") as temporary:
            root = Path(temporary)
            regular = root / "regular"
            regular.write_bytes(b"hosted-probe-control")
            directory = root / "directory"
            directory.mkdir()
            link = root / "link"
            link.symlink_to(regular)
            broken = root / "broken"
            broken.symlink_to(root / "missing")

            def local_sudo(*args, label):
                if args[:3] != ("/usr/bin/python3", "-c", HOSTED_PATH_STATE_SCRIPT):
                    raise SystemExit("HOSTED_PATH_PROBE_ROUTE_INVALID")
                return hosted_run(list(args), label)

            globals()["hosted_sudo"] = local_sudo
            if hosted_protected_state(root / "missing") is not None:
                raise SystemExit("HOSTED_PATH_PROBE_ABSENCE_INVALID")
            file_state = hosted_protected_state(regular, digest=True)
            if file_state["kind"] != "regular" or file_state["sha256"] != hashlib.sha256(b"hosted-probe-control").hexdigest():
                raise SystemExit("HOSTED_PATH_PROBE_FILE_INVALID")
            if hosted_protected_state(directory)["kind"] != "directory":
                raise SystemExit("HOSTED_PATH_PROBE_DIRECTORY_INVALID")
            if hosted_protected_state(link)["kind"] != "symlink" or hosted_protected_state(broken)["kind"] != "symlink":
                raise SystemExit("HOSTED_PATH_PROBE_SYMLINK_INVALID")
            try:
                hosted_protected_state(link / "child")
            except HostedDeploymentFailure:
                pass
            else:
                raise SystemExit("HOSTED_PATH_PROBE_PARENT_SYMLINK_ACCEPTED")

            def denied_sudo(*args, label):
                raise HostedDeploymentFailure("HOSTED_PATH_PROBE_PERMISSION_DENIED")

            globals()["hosted_sudo"] = denied_sudo
            try:
                hosted_protected_state(root / "missing")
            except HostedDeploymentFailure as error:
                if str(error) != "HOSTED_PATH_PROBE_PERMISSION_DENIED":
                    raise
            else:
                raise SystemExit("HOSTED_PATH_PROBE_PERMISSION_AS_ABSENCE")

            def malformed_sudo(*args, label):
                return '{"state":"absent","uncertain":true}\n'

            globals()["hosted_sudo"] = malformed_sudo
            try:
                hosted_protected_state(root / "missing")
            except HostedDeploymentFailure:
                pass
            else:
                raise SystemExit("HOSTED_PATH_PROBE_MALFORMED_ACCEPTED")
    finally:
        globals()["hosted_sudo"] = original_sudo
    print("HOSTED_PROTECTED_PATH_PROBE_REGRESSIONS=PASS")


assert_hosted_probe_regressions()


def assert_hosted_acl_regressions():
    runner_uid = "1001"
    state = {"state": "present", "kind": "directory", "device": 17, "inode": 23, "uid": 0, "gid": 0, "mode": 0o710, "nlink": 2}
    exact = "user::rwx\nuser:1001:--x\ngroup::---\nmask::--x\nother::---\n"
    reordered = "# file: omitted-by-header-option\n  other : : ---\r\nmask::--x\r\ngroup::---  #effective:---\r\nuser:1001:--x\t#effective:--x\r\nuser::rwx\r\n"
    hosted_verify_acl_semantics(exact, "", runner_uid, state, state)
    hosted_verify_acl_semantics(reordered, "  \n", runner_uid, state, state)
    print("HOSTED_ACL_SEMANTIC_POSITIVE_CONTROLS=PASS")

    changed_mode = dict(state, mode=0o750)
    changed_inode = dict(state, inode=24)
    invalid = {
        "EXTRA_NAMED_USER": (exact + "user:2002:--x\n", "", runner_uid, state, state),
        "EXTRA_NAMED_GROUP": (exact + "group:2002:--x\n", "", runner_uid, state, state),
        "WRONG_RUNNER_UID": (exact.replace("user:1001", "user:1002"), "", runner_uid, state, state),
        "WRONG_MASK": (exact.replace("mask::--x", "mask::r-x"), "", runner_uid, state, state),
        "WRONG_GROUP": (exact.replace("group::---", "group::r-x"), "", runner_uid, state, state),
        "WRONG_OTHER": (exact.replace("other::---", "other::--x"), "", runner_uid, state, state),
        "DEFAULT_ACL": (exact, "default:user::rwx\ndefault:group::--x\n", runner_uid, state, state),
        "EFFECTIVE_RIGHTS": (exact.replace("user:1001:--x", "user:1001:--x\t#effective:---"), "", runner_uid, state, state),
        "MALFORMED_OUTPUT": (exact + "unrecognized:private-data\n", "", runner_uid, state, state),
        "DUPLICATE_ENTRY": (exact + "user::rwx\n", "", runner_uid, state, state),
        "WRONG_ROOT_MODE": (exact, "", runner_uid, state, changed_mode),
        "CHANGED_ROOT_IDENTITY": (exact, "", runner_uid, state, changed_inode),
    }
    for label, args in invalid.items():
        try:
            hosted_verify_acl_semantics(*args)
        except HostedDeploymentFailure as error:
            marker, diagnostic_text = str(error).split(":", 1)
            diagnostic = json.loads(diagnostic_text)
            if marker != "HOSTED_PRIVATE_ROOT_ACL_INVALID" or not isinstance(diagnostic["access"], list) or not isinstance(diagnostic["default"], list) or diagnostic["uid"] != 0 or diagnostic["gid"] != 0 or len(diagnostic_text) > 4096 or "private-data" in diagnostic_text:
                raise SystemExit("HOSTED_ACL_DIAGNOSTIC_INVALID:" + label)
        else:
            raise SystemExit("HOSTED_ACL_NEGATIVE_CONTROL_ACCEPTED:" + label)
        print("HOSTED_ACL_NEGATIVE_CONTROL_" + label + "=PASS")

    original_sudo, original_probe = hosted_sudo, hosted_protected_state
    calls = []
    try:
        def fake_probe(path):
            if path != HOSTED_PRIVATE_ROOT:
                raise SystemExit("HOSTED_ACL_PROBE_TARGET_INVALID")
            calls.append("probe")
            return dict(state)

        def fake_sudo(*args, label):
            calls.append(args)
            if args[0] == "/usr/bin/setfacl":
                return ""
            if args[0] == "/usr/bin/getfacl" and "--access" in args:
                return reordered
            if args[0] == "/usr/bin/getfacl" and "--default" in args:
                return ""
            raise SystemExit("HOSTED_ACL_PRIVILEGED_ROUTE_INVALID")

        globals()["hosted_protected_state"] = fake_probe
        globals()["hosted_sudo"] = fake_sudo
        verified = hosted_verify_private_root_acl(runner_uid)
        if verified["identity"] != state or not isinstance(verified["access"], dict) or verified["defaults"]:
            raise SystemExit("HOSTED_ACL_VERIFIED_RECORDS_INVALID")
        if len(calls) != 5 or calls[0] != "probe" or calls[-1] != "probe" or calls[1][0] != "/usr/bin/setfacl" or "--no-mask" not in calls[1] or "--access" not in calls[2] or "--default" not in calls[3] or any("--physical" not in args or "--absolute-names" not in args for args in calls[2:4]):
            raise SystemExit("HOSTED_ACL_PRIVILEGED_ROUTE_INVALID")

        def denied_read(*args, label):
            if args[0] == "/usr/bin/getfacl":
                raise HostedDeploymentFailure("PRIVATE_UNTRUSTED_TOOL_OUTPUT")
            return ""

        globals()["hosted_sudo"] = denied_read
        try:
            hosted_verify_private_root_acl(runner_uid)
        except HostedDeploymentFailure as error:
            if not str(error).startswith("HOSTED_PRIVATE_ROOT_ACL_READ_FAILED:") or "PRIVATE_UNTRUSTED_TOOL_OUTPUT" in str(error):
                raise SystemExit("HOSTED_ACL_READ_FAILURE_DIAGNOSTIC_INVALID")
        else:
            raise SystemExit("HOSTED_ACL_PRIVILEGED_READ_FAILURE_ACCEPTED")

        def denied_default(*args, label):
            if "--default" in args:
                raise HostedDeploymentFailure("PRIVATE_UNTRUSTED_TOOL_OUTPUT")
            return reordered if "--access" in args else ""

        globals()["hosted_sudo"] = denied_default
        try:
            hosted_verify_private_root_acl(runner_uid)
        except HostedDeploymentFailure as error:
            if not str(error).startswith("HOSTED_PRIVATE_ROOT_ACL_READ_FAILED:") or "PRIVATE_UNTRUSTED_TOOL_OUTPUT" in str(error) or "user:1001:--x" not in str(error):
                raise SystemExit("HOSTED_ACL_DEFAULT_READ_DIAGNOSTIC_INVALID")
        else:
            raise SystemExit("HOSTED_ACL_PRIVILEGED_DEFAULT_READ_FAILURE_ACCEPTED")

        probe_calls = [0]

        def denied_post_probe(path):
            probe_calls[0] += 1
            if probe_calls[0] == 2:
                raise HostedDeploymentFailure("HOSTED_PATH_PROBE_FAILED")
            return dict(state)

        globals()["hosted_sudo"] = fake_sudo
        globals()["hosted_protected_state"] = denied_post_probe
        try:
            hosted_verify_private_root_acl(runner_uid)
        except HostedDeploymentFailure as error:
            if not str(error).startswith("HOSTED_PRIVATE_ROOT_ACL_IDENTITY_READ_FAILED:") or "HOSTED_PATH_PROBE_FAILED" in str(error) or "user:1001:--x" not in str(error):
                raise SystemExit("HOSTED_ACL_POST_PROBE_DIAGNOSTIC_INVALID")
        else:
            raise SystemExit("HOSTED_ACL_POST_PROBE_FAILURE_ACCEPTED")

        def denied_probe(path):
            raise HostedDeploymentFailure("HOSTED_PATH_PROBE_FAILED")

        globals()["hosted_protected_state"] = denied_probe
        try:
            hosted_verify_private_root_acl(runner_uid)
        except HostedDeploymentFailure as error:
            if not str(error).startswith("HOSTED_PRIVATE_ROOT_ACL_IDENTITY_READ_FAILED:") or "HOSTED_PATH_PROBE_FAILED" in str(error):
                raise SystemExit("HOSTED_ACL_PROBE_FAILURE_DIAGNOSTIC_INVALID")
        else:
            raise SystemExit("HOSTED_ACL_PRIVILEGED_PROBE_FAILURE_ACCEPTED")
    finally:
        globals()["hosted_sudo"] = original_sudo
        globals()["hosted_protected_state"] = original_probe
    print("HOSTED_ACL_PRIVILEGED_ROUTE_REGRESSIONS=PASS")


assert_hosted_acl_regressions()


def invoke(args, payload=b""):
    return subprocess.run(
        [production, *args], input=payload, check=False, capture_output=True, timeout=5
    )


completed = subprocess.run(
    [contract, "--contract-self-test"], check=False, capture_output=True, timeout=5
)
if completed.returncode != 0 or completed.stdout or completed.stderr:
    raise SystemExit(f"BROKER_CONTRACT_SELF_TEST_FAILED:{completed.returncode}")

for args in [[], ["--recover-v1", "extra"], ["--stdio-v1", "extra"], ["--arbitrary-command"]]:
    result = invoke(args)
    if result.returncode != 64 or result.stdout or result.stderr:
        raise SystemExit(f"BROKER_ARGUMENT_ADMISSION_FAILED:{args!r}:{result.returncode}")


def assert_protocol_rejection(header, expected_operation, expected_request_id):
    result = invoke(["--stdio-v1"], header)
    if result.returncode != 0 or result.stderr:
        raise SystemExit(f"BROKER_MALFORMED_REQUEST_PROCESS_FAILED:{result.returncode}")
    response = result.stdout
    if len(response) < 320 or response[:8] != b"S8BRS001":
        raise SystemExit("BROKER_RESPONSE_HEADER_INVALID")
    if struct.unpack_from(">H", response, 8)[0] != 1:
        raise SystemExit("BROKER_RESPONSE_VERSION_INVALID")
    if response[10] != expected_operation or response[11] != 0:
        raise SystemExit("BROKER_RESPONSE_OPERATION_INVALID")
    if response[12:28] != expected_request_id:
        raise SystemExit("BROKER_RESPONSE_REQUEST_ID_INVALID")
    if struct.unpack_from(">H", response, 28)[0] != 64 or response[30:32] != b"\0\0":
        raise SystemExit("BROKER_PROTOCOL_STATUS_INVALID")
    lengths = struct.unpack_from(">5Q", response, 184)
    if sum(lengths) != len(response) - 320:
        raise SystemExit("BROKER_RESPONSE_LENGTH_INVALID")
    sections = []
    offset = 320
    for length in lengths:
        sections.append(response[offset : offset + length])
        offset += length
    if hashlib.sha256(b"".join(sections)).digest() != response[224:256]:
        raise SystemExit("BROKER_RESPONSE_SECTION_DIGEST_INVALID")
    if response[256:320] != bytes(64) or any(lengths[:4]) or not lengths[4]:
        raise SystemExit("BROKER_PROTOCOL_FAILURE_SECTIONS_INVALID")
    try:
        metadata = json.loads(sections[4])
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise SystemExit("BROKER_FAILURE_METADATA_INVALID") from error
    operation_names = {1: "WRITER", 2: "VALIDATOR", 3: "RECOVER"}
    if metadata.get("schemaVersion") != "s8-sandbox-broker-metadata-v1":
        raise SystemExit("BROKER_FAILURE_METADATA_SCHEMA_INVALID")
    if metadata.get("operation") != operation_names[expected_operation]:
        raise SystemExit("BROKER_FAILURE_METADATA_OPERATION_INVALID")


bad_magic = bytearray(160)
bad_magic[10] = 2
bad_magic[12:28] = bytes(range(16))
assert_protocol_rejection(bytes(bad_magic), 2, bytes(range(16)))

reserved_byte = bytearray(160)
reserved_byte[:8] = b"S8BRQ001"
struct.pack_into(">H", reserved_byte, 8, 1)
reserved_byte[10] = 1
reserved_byte[11] = 1
reserved_byte[12:28] = b"broker-test-id-1"
assert_protocol_rejection(bytes(reserved_byte), 1, b"broker-test-id-1")

invalid_operation = bytearray(160)
invalid_operation[:8] = b"S8BRQ001"
struct.pack_into(">H", invalid_operation, 8, 1)
invalid_operation[10] = 4
invalid_operation[12:28] = b"broker-test-id-2"
assert_protocol_rejection(bytes(invalid_operation), 1, b"broker-test-id-2")

print("BROKER_CONTRACT_SELF_TEST=PASS")
print("BROKER_ARGUMENT_ADMISSION=PASS")
print("BROKER_MALFORMED_PROTOCOL_RESPONSES=PASS")


repo_root = Path(__file__).resolve().parents[3]
workflow_path = repo_root / ".github/workflows/s8-fbx.yml"
proof_path = repo_root / "scripts/s8/s8_application_boundary_proof.mts"
proof_helper_path = repo_root / "scripts/s8/s8_application_boundary_proof.sh"
worker_path = repo_root / "src/lib/s8-fbx-worker.ts"
broker_path = repo_root / "native/s8-sandbox-broker/src/broker.c"
namespace_path = repo_root / "native/s8-sandbox-broker/tests/hosted_deployment_namespace.py"
deployment_path = Path(__file__).resolve()


def valid_hosted_protected_harness(deployment):
    try:
        tree = ast.parse(deployment)
        probe_source = deployment.split("HOSTED_PATH_STATE_SCRIPT = r'''", 1)[1].split("'''", 1)[0]
        probe = ast.parse(probe_source)
    except (SyntaxError, IndexError):
        return False
    if probe_source.count("os.O_NOFOLLOW") != 3 or probe_source.count("follow_symlinks=False") != 2:
        return False
    probe_handlers = [node for node in ast.walk(probe) if isinstance(node, ast.ExceptHandler)]
    if len(probe_handlers) != 1 or not isinstance(probe_handlers[0].type, ast.Name) or probe_handlers[0].type.id != "FileNotFoundError":
        return False
    if any(token not in deployment for token in (
        'os.O_NOFOLLOW | os.O_CLOEXEC',
        'follow_symlinks=False',
        'hosted_sudo("/usr/bin/python3", "-c", HOSTED_PATH_STATE_SCRIPT',
        'hosted_protected_state(path, digest=True)',
        'hosted_sudo("/usr/sbin/visudo", "-c", "-f", str(HOSTED_SUDOERS)',
    )):
        return False
    functions = {node.name: node for node in tree.body if isinstance(node, ast.FunctionDef)}
    protected_receivers = {
        "hosted_record_directory": {"path"},
        "hosted_record_file": {"path"},
        "hosted_create_directory": {"path"},
        "hosted_install": {"target"},
        "hosted_file_digest": {"path"},
        "hosted_verify_private_root_acl": {"HOSTED_PRIVATE_ROOT"},
        "hosted_policy": {"HOSTED_PRIVATE_ROOT"},
        "hosted_cleanup": {"journal", "target", "HOSTED_BROKER", "HOSTED_POLICY_PATH"},
        "hosted_deploy": {"path", "parent", "HOSTED_SUDOERS"},
    }
    forbidden_methods = {"exists", "is_file", "is_dir", "is_symlink", "lstat", "stat", "open", "read_bytes", "read_text"}
    for name, receivers in protected_receivers.items():
        function = functions.get(name)
        if function is None:
            return False
        for node in ast.walk(function):
            if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Attribute):
                continue
            if isinstance(node.func.value, ast.Name) and node.func.value.id == "os" and node.func.attr in {"open", "stat", "lstat", "access"} and node.args and isinstance(node.args[0], ast.Name) and node.args[0].id in receivers:
                return False
            if node.func.attr not in forbidden_methods:
                continue
            receiver = node.func.value
            if isinstance(receiver, ast.Name) and receiver.id in receivers:
                return False
            if name == "hosted_deploy" and isinstance(receiver, ast.Call) and isinstance(receiver.func, ast.Name) and receiver.func.id == "Path" and receiver.args and isinstance(receiver.args[0], ast.Constant) and receiver.args[0].value == "/etc/swooshz":
                return False
    required = {
        "hosted_record_directory": ("state = hosted_protected_state(path)",),
        "hosted_record_file": ("state = hosted_protected_state(path, digest=True)",),
        "hosted_create_directory": ("hosted_protected_state(path) is not None",),
        "hosted_install": ("hosted_protected_state(target) is not None",),
        "hosted_file_digest": ("hosted_protected_state(path, digest=True)",),
        "hosted_verify_private_root_acl": (
            "before = hosted_protected_state(HOSTED_PRIVATE_ROOT)",
            'acl = f"u::rwx,u:{runner_uid}:--x,g::---,m::--x,o::---"',
            'hosted_sudo("/usr/bin/setfacl", "--no-mask", "--set", acl',
            'access_text = hosted_sudo("/usr/bin/getfacl"',
            '"--all-effective", "--access"',
            'default_text = hosted_sudo("/usr/bin/getfacl"',
            '"--all-effective", "--default"',
            "after = hosted_protected_state(HOSTED_PRIVATE_ROOT)",
            "hosted_verify_acl_semantics(access_text, default_text, runner_uid, before, after)",
        ),
        "hosted_verify_acl_semantics": (
            '"user:": "rwx"',
            '"user:" + str(runner_uid): "--x"',
            '"group:": "---"',
            '"mask:": "--x"',
            '"other:": "---"',
            "if reported is not None and reported != derived:",
            'effective_mismatch.append(key + ":REPORTED")',
            "access_rights != expected or defaults or effective_mismatch or not identity_match",
        ),
        "hosted_policy": ("root_state = hosted_protected_state(HOSTED_PRIVATE_ROOT)",),
        "hosted_cleanup": (
            "journal_state = hosted_protected_state(journal)",
            "broker_state = hosted_protected_state(HOSTED_BROKER)",
            "policy_state = hosted_protected_state(HOSTED_POLICY_PATH)",
            'hosted_sudo(str(HOSTED_BROKER), "--recover-v1", label="HOSTED_BROKER_RECOVERY_FAILED")',
            'print("BROKER_RECOVERY_CLEANUP=PASS")',
            "HOSTED_JOURNAL_CLEANUP_SCRIPT",
            "hosted_protected_state(journal) is not None",
            "state = hosted_protected_state(target, digest=True)",
            "if hosted_protected_state(target) is not None:",
            "state = hosted_protected_state(target)",
        ),
        "hosted_deploy": (
            "hosted_verify_opt_namespace(runner_uid)",
            "if any(hosted_protected_state(path) is not None for path in absent):",
            "parent_state = hosted_protected_state(parent)",
            'hosted_protected_state(Path("/etc/swooshz")) is None',
            'hosted_sudo("/usr/sbin/visudo", "-c", "-f", str(HOSTED_SUDOERS)',
            "hosted_file_digest(HOSTED_POLICY_PATH, 0o600) != policy_file_hash",
            "hosted_verify_private_root_acl(runner_uid)",
            "hosted_verify_opt_product_paths()",
        ),
    }
    for name, tokens in required.items():
        source = ast.get_source_segment(deployment, functions[name])
        if source is None or any(token not in source for token in tokens):
            return False
    return True


def valid_hosted_binding(workflow, deployment, proof_helper, worker, broker, proof_bytes, helper_bytes):
    if not valid_hosted_protected_harness(deployment):
        return False
    pinned_helpers = (
        (proof_bytes, 8966, "05c7b06a96fe0c45be71a4e2805b29202250130c9dba4bb852a0ef6032aacd31"),
        (helper_bytes, 3260, "105085a773513c05abdfbc6b0b6da67b74ad8eb811c91c919cc7a08645bd769e"),
    )
    for content, expected_length, expected_digest in pinned_helpers:
        if len(content) != expected_length or hashlib.sha256(content).hexdigest() != expected_digest:
            return False
    try:
        proof_text, helper_text = proof_bytes.decode("utf-8"), helper_bytes.decode("utf-8")
    except UnicodeDecodeError:
        return False

    begin = "# RUN107_HOSTED_BROKER_DEPLOYMENT_BEGIN"
    end = "# RUN107_HOSTED_BROKER_DEPLOYMENT_END"
    source = 'source "$GITHUB_WORKSPACE/scripts/s8/s8_application_boundary_proof.sh"'
    if workflow.count(begin) != 1 or workflow.count(end) != 1 or workflow.count(source) != 1:
        return False
    binding_markers = (
        "APPLICATION_PRIVATE_ROOT_BINDING=PASS",
        "APPLICATION_POLICY_H_BINDING=PASS",
        "APPLICATION_CONFIG_Q_BINDING=PASS",
        "APPLICATION_SANDBOX_BINDING=PASS",
        "SAME_POLICY_SNAPSHOT_BINDING=PASS",
    )
    if any(workflow.count(marker) != 1 for marker in binding_markers):
        return False
    begin_index, end_index, source_index = workflow.index(begin), workflow.index(end), workflow.index(source)
    if not begin_index < end_index < source_index:
        return False
    if any(workflow.index(marker) < source_index for marker in binding_markers):
        return False
    block = workflow[begin_index:end_index]
    workflow_tokens = (
        '--hosted-deploy "$carrier" "$temp_root" "$runner_uid" "$runner_gid"',
        'S8_APP_PRIVATE_ROOT="$(/usr/bin/awk',
        'S8_APP_SANDBOX_POLICY_SHA256="$(/usr/bin/awk',
        'S8_APP_CONFIG_SHA256="$(/usr/bin/awk',
        'S8_APP_SANDBOX="$(/usr/bin/awk',
        '[[ "$S8_APP_PRIVATE_ROOT" == /var/lib/swooshz/s8 && "$S8_APP_SANDBOX" == /usr/local/libexec/swooshz-s8/s8-sandbox ]]',
        '"$S8_APP_SANDBOX_POLICY_SHA256" ]] || fail_amendment "APPLICATION_POLICY_SNAPSHOT_MISMATCH"',
        '"$S8_APP_CONFIG_SHA256" ]] || fail_amendment "APPLICATION_CONFIG_SNAPSHOT_MISMATCH"',
        "CONFIG_DIGEST_INCLUDES_POLICY_DIGEST=YES",
        "export S8_APP_PRIVATE_ROOT S8_APP_SANDBOX_POLICY_SHA256 S8_APP_CONFIG_SHA256 S8_APP_SANDBOX",
    )
    if any(token not in block for token in workflow_tokens):
        return False
    if any(token not in workflow for token in (
        '--hosted-cleanup "$temp_root"',
        "if (( all_launched_children_reaped == 1 ))",
        "broker_deployment_attempted=0",
        "TEMP_CLEANUP_RESULT=DEFERRED_BROKER_DEPLOYMENT_RESIDUE",
    )):
        return False

    policy_start = deployment.find("def hosted_policy(")
    policy_end = deployment.find("\ndef hosted_load_ledger(", policy_start)
    deploy_start = deployment.find("def hosted_deploy(")
    deploy_end = deployment.find("\ndef hosted_cli(", deploy_start)
    if min(policy_start, deploy_start) < 0 or policy_end <= policy_start or deploy_end <= deploy_start:
        return False
    policy, deploy = deployment[policy_start:policy_end], deployment[deploy_start:deploy_end]
    deployment_paths = (
        'HOSTED_POLICY_PATH = Path("/etc/swooshz/s8-broker-v1.json")',
        'HOSTED_PRIVATE_ROOT = Path("/var/lib/swooshz/s8")',
        'HOSTED_LAUNCHER = Path("/usr/local/libexec/swooshz-s8/s8-sandbox")',
        'HOSTED_BROKER = Path("/usr/local/libexec/swooshz-s8/s8-sandbox-broker")',
    )
    if any(token not in deployment for token in deployment_paths):
        return False
    deploy_tokens = (
        "hosted_verify_opt_namespace(runner_uid)",
        'hosted_run(["/usr/local/bin/cmake", "-S", str(workspace / "native/s8-sandbox-broker")',
        'hosted_run(["/usr/local/bin/cmake", "--build", str(build)',
        'hosted_run(["/usr/local/bin/ctest", "--test-dir", str(build)',
        'broker_build = build / "s8-sandbox-broker"',
        "hosted_create_directory(temp_root, HOSTED_RUNTIME, 0o755)",
        "hosted_create_directory(temp_root, HOSTED_WRITER_ROOT, 0o755)",
        "hosted_create_directory(temp_root, HOSTED_PRIVATE_ROOT, 0o710)",
        "hosted_verify_private_root_acl(runner_uid)",
        'print("HOSTED_PRIVATE_ROOT_ACL=PASS")',
        "hosted_verify_opt_product_paths()",
        "hosted_install(temp_root, broker_build, HOSTED_BROKER, 0o755)",
        'hosted_install(temp_root, workspace / "native/s8-sandbox-broker/deploy/s8-sandbox", HOSTED_LAUNCHER, 0o755)',
        'hosted_install(temp_root, workspace / "native/s8-sandbox-broker/deploy/swooshz-s8-broker-recover.service"',
        'hosted_install(temp_root, workspace / "native/s8-sandbox-broker/deploy/swooshz-s8-broker-recover.timer"',
        "policy_tmp, policy_h, config_q, policy_file_hash = hosted_policy(",
        "hosted_install(temp_root, policy_tmp, HOSTED_POLICY_PATH, 0o600)",
        'hosted_sudo(str(HOSTED_BROKER), "--recover-v1"',
        'print("BROKER_RECOVER=PASS")',
        'print("BROKER_POLICY_ADMISSION=PASS")',
        'print("HOSTED_POLICY_H=" + policy_h)',
        'print("HOSTED_CONFIG_Q=" + config_q)',
        'print("S8_APP_PRIVATE_ROOT=" + str(HOSTED_PRIVATE_ROOT))',
        'print("S8_APP_SANDBOX_POLICY_SHA256=" + policy_h)',
        'print("S8_APP_CONFIG_SHA256=" + config_q)',
        'print("S8_APP_SANDBOX=" + str(HOSTED_LAUNCHER))',
    )
    positions = [deploy.find(token) for token in deploy_tokens]
    if any(position < 0 for position in positions) or positions != sorted(positions):
        return False
    policy_tokens = (
        "root_state = hosted_protected_state(HOSTED_PRIVATE_ROOT)",
        '"privateWorkRoot": str(HOSTED_PRIVATE_ROOT)',
        '"sandboxExecutable": str(HOSTED_LAUNCHER)',
        '"blenderExecutableSha256": hosted_file_digest(HOSTED_RUNTIME / "blender", 0o755)',
        '"privateRootDevice": str(root_state["device"])',
        '"privateRootInode": str(root_state["inode"])',
        '"launcherSha256": hosted_file_digest(HOSTED_LAUNCHER, 0o755)',
        '"brokerSha256": hosted_file_digest(HOSTED_BROKER, 0o755)',
        '"runnerSha256": hosted_file_digest(HOSTED_RUNNER, 0o755)',
        '"validatorSha256": hosted_file_digest(HOSTED_VALIDATOR, 0o755)',
        '"writerSha256": hosted_file_digest(HOSTED_WRITER_ROOT / "writer.py", 0o644)',
        'policy_h = hashlib.sha256(hosted_canonical(policy)).hexdigest()',
        'config["sandboxPolicySha256"] = policy_h',
        'config_q = hashlib.sha256(hosted_canonical(config)).hexdigest()',
        'del preimage["config"]["sandboxPolicySha256"]',
        "hashlib.sha256(hosted_canonical(preimage)).hexdigest() != policy_h",
        'hashlib.sha256(hosted_canonical(reconstructed["config"])).hexdigest() != config_q',
    )
    positions = [policy.find(token) for token in policy_tokens]
    if any(position < 0 for position in positions) or positions != sorted(positions):
        return False
    if re.search(r"""["'][0-9a-f]{64}["']""", policy + deploy):
        return False

    proof_tokens = (
        "process.env.S8_APP_PRIVATE_ROOT!",
        "process.env.S8_APP_SANDBOX_POLICY_SHA256!",
        "process.env.S8_APP_SANDBOX!",
        "runS8BlenderWriter(prepared.bytes, workerConfig)",
        "runS8NativeValidator(written.artifact, workerConfig)",
        "compareS8UfbxReadback(s6, s7, native.readback)",
        '"APPLICATION_EXPLICIT_SETENV_COUNT=0"',
        '"FINAL_RUNTIME_ALLOWLIST_PROOF=PASS"',
        '"BROAD_RUNTIME_BINDS_ABSENT=YES"',
    )
    helper_tokens = (
        "S8_APP_PRIVATE_ROOT",
        "S8_APP_SANDBOX_POLICY_SHA256",
        "is required",
        'S8_APP_SANDBOX:-/usr/local/libexec/swooshz-s8/s8-sandbox',
        "TARGET_ENV_KEYS=PWD",
        "PARENT_SECRET_HOSTILE_ENV_LEAKAGE=NO",
        "PRODUCTION_BOUNDARY_PROOF=PASS",
    )
    if any(token not in proof_text for token in proof_tokens) or any(token not in helper_text for token in helper_tokens):
        return False

    worker_tokens = (
        'const BROKER_LAUNCHER_PATH = "/usr/local/libexec/swooshz-s8/s8-sandbox";',
        "config.sandboxExecutable !== BROKER_LAUNCHER_PATH",
        'const launcher = assertRegularFile(config.sandboxExecutable ?? "", "sandboxExecutable");',
        'if (launcher !== BROKER_LAUNCHER_PATH) fail("S8_WORKER_SANDBOX_REQUIRED");',
        "spawnSync(/* turbopackIgnore: true */ launcher, [], {",
        "const configSha256 = s8Sha256(canonicalS8ConfigBytes(config));",
        'Buffer.from(config.sandboxPolicySha256, "hex").copy(header, 28);',
        'Buffer.from(configSha256, "hex").copy(header, 60);',
        "policySha256: string; configSha256: string",
        "expected.policySha256 && header.subarray(152, 184).toString",
        "if (response.brokerStatus === 0 && !response.identityBound)",
        "policySha256: config.sandboxPolicySha256, configSha256: request.configSha256",
        "validateS8BrokerResponseIdentity(response);",
        "shell: false",
    )
    broker_tokens = (
        "serialize_policy(&preimage, policy, 0)",
        "sha256_bytes(preimage.bytes, preimage.length, policy_digest)",
        "strcmp(policy->policy_sha256, policy->config.sandbox_policy_sha256) != 0",
        "serialize_config(&config_bytes, &policy->config, 1)",
        "sha256_bytes(config_bytes.bytes, config_bytes.length, config_digest)",
        "constant_equal(request->policy_sha256, expected_policy, sizeof(expected_policy))",
        "constant_equal(request->config_sha256, expected_config, sizeof(expected_config))",
    )
    if any(token not in worker for token in worker_tokens) or any(token not in broker for token in broker_tokens):
        return False
    if "/usr/bin/bwrap" in proof_text + helper_text + worker:
        return False
    if 'S8_APP_SANDBOX:-/usr/bin/bwrap' in helper_text or 'sandboxExecutable || "/usr/bin/bwrap"' in worker:
        return False
    return True


workflow_source = workflow_path.read_text(encoding="utf-8")
deployment_source = deployment_path.read_text(encoding="utf-8")
namespace_source = namespace_path.read_text(encoding="utf-8")
proof_helper_source = proof_helper_path.read_text(encoding="utf-8")
worker_source = worker_path.read_text(encoding="utf-8")
broker_source = broker_path.read_text(encoding="utf-8")
proof_bytes = proof_path.read_bytes()
helper_bytes = proof_helper_path.read_bytes()


def hosted_binding_accepts(candidate):
    workflow, deployment, candidate_proof, candidate_helper, worker, broker = candidate
    return valid_hosted_binding(
        workflow,
        deployment,
        proof_helper_source,
        worker,
        broker,
        candidate_proof,
        candidate_helper,
    )


def valid_hosted_namespace_binding(workflow, deployment, namespace):
    try:
        namespace_ast = ast.parse(namespace)
        ast.parse(deployment)
    except SyntaxError:
        return False
    if any(
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == "emit"
        and len(node.args) != 2
        for node in ast.walk(namespace_ast)
    ):
        return False
    workflow_wrapper = 'hosted_deployment_namespace.py" --hosted-namespace-run "$0"'
    if workflow.count(workflow_wrapper) != 1 or workflow.count('S8_MOUNT_NAMESPACE_ACTIVE:-0') != 1:
        return False
    wrapper_at = workflow.index(workflow_wrapper)
    original_workflow_at = workflow.find("candidate_started=0", wrapper_at)
    if original_workflow_at < 0:
        return False
    if re.search(r"[\"']--(?:user|pid)[\"']", namespace):
        return False
    required_namespace = (
        '"/usr/bin/unshare", "--mount", "--fork"',
        '"/usr/bin/unshare", "--kill-child=TERM", "--mount", "--fork"',
        'run_mount(["--make-rprivate", "/"]',
        'emit("MOUNT_PROPAGATION", "RECURSIVELY_PRIVATE")',
        'run_mount(["--rbind", str(HOSTEDTOOLCACHE), str(staged_toolcache)]',
        '"-t", "tmpfs", "-o", "size=4g,mode=0755,uid=0,gid=0,nosuid,nodev"',
        'emit("ROUTE_B_OPT_MOUNT_PROVEN", "PASS")',
        'run_mount(["--rbind", str(staged_toolcache), str(HOSTEDTOOLCACHE)]',
        'staging_root = Path(args.outer_state).parent',
        'opt_mount_proven = "ROUTE_B_OPT_MOUNT_PROVEN=PASS" in output_markers',
        'if opt_mount_proven:',
        'outer = read_json_stdin()',
        'emit("FAILURE_CONTROL_READY_JSON"',
        '"/usr/bin/sudo", "-n", "/usr/bin/kill", "-TERM", "--"',
        '"--namespace-process-check", record["mnt"]',
        'def namespace_process_check(mnt_identity)',
        "def verify_outer_unchanged(before, *, label)",
        "def run_failure_control(outer, workdir)",
        "def namespace_processes(mnt_identity",
        '"/usr/bin/umount", "--"',
        'emit("HOSTEDTOOLCACHE_RUNTIME_ALLOWLIST", "HARNESS_ONLY")',
        'emit("ROUTE_B_CAPABILITY_PROVEN", "YES")',
    )
    if any(token not in namespace for token in required_namespace):
        return False
    inner_node = next((node for node in namespace_ast.body if isinstance(node, ast.FunctionDef) and node.name == "run_inner_workload"), None)
    if inner_node is None:
        return False
    inner_source = ast.get_source_segment(namespace, inner_node)
    ordered_inner_tokens = (
        'run_mount(["--make-rprivate", "/"]',
        'run_mount(["--rbind", str(HOSTEDTOOLCACHE), str(staged_toolcache)]',
        'run_mount(["--make-rprivate", str(staged_toolcache)]',
        'run_mount(["-t", "tmpfs", "-o", "size=4g,mode=0755,uid=0,gid=0,nosuid,nodev", "tmpfs", str(OPT)]',
        "opt_info = verify_inner_opt(outer)",
        'emit("ROUTE_B_OPT_MOUNT_PROVEN", "PASS")',
        'run_mount(["--rbind", str(staged_toolcache), str(HOSTEDTOOLCACHE)]',
        'run_mount(["--make-rprivate", str(HOSTEDTOOLCACHE)]',
        "namespace_expected_mountinfo, namespace_expected_mounts = mount_table()",
        "actual_uid = checked(identity_cmd",
        "workflow = subprocess.Popen(",
        "current_mount_text, current_mounts = mount_table()",
        "run_unmount(OPT, owned_opt_mount)",
        "restored = stat_identity(OPT)",
    )
    positions = [inner_source.find(token) for token in ordered_inner_tokens]
    if any(position < 0 for position in positions) or positions != sorted(positions):
        return False
    if any(token not in inner_source for token in (
        'inner_ns["mnt"] == outer["namespaces"]["mnt"]',
        'inner_ns["user"] != outer["namespaces"]["user"]',
        'inner_ns["pid"] != outer["namespaces"]["pid"]',
        'prefix + ["/usr/bin/bash"',
        'emit("HOSTED_CALLER_IDENTITY", "PASS")',
    )):
        return False
    required_deployment = (
        'HOSTED_OPT = Path("/opt")',
        'HOSTED_RUNTIME = Path("/opt/blender")',
        'HOSTED_WRITER_ROOT = Path("/opt/swooshz")',
        'expected_access = {"user:": "rwx", "group:": "r-x", "other:": "r-x"}',
        'mount["filesystem"] != "tmpfs"',
        'hosted_verify_opt_namespace(runner_uid)',
        'hosted_verify_opt_product_paths()',
        '"/var/lib/swooshz/s8"',
        'print("HOSTED_PRIVATE_ROOT_ACL=PASS")',
        'acl = f"u::rwx,u:{runner_uid}:--x,g::---,m::--x,o::---"',
    )
    if any(token not in deployment for token in required_deployment):
        return False
    return True


positive_control = (
    workflow_source,
    deployment_source,
    proof_bytes,
    helper_bytes,
    worker_source,
    broker_source,
)
if not hosted_binding_accepts(positive_control):
    raise SystemExit("HOSTED_COMBINED_BROKER_APPLICATION_BINDING_INVALID")
if not valid_hosted_namespace_binding(workflow_source, deployment_source, namespace_source):
    raise SystemExit("HOSTED_MOUNT_NAMESPACE_APPLICATION_BINDING_INVALID")
namespace_self_test = subprocess.run([sys.executable, str(namespace_path), "--self-test"], check=False, capture_output=True, timeout=5)
if namespace_self_test.returncode != 0 or namespace_self_test.stdout.strip() != b"HOSTED_NAMESPACE_HARNESS_SELF_TEST=PASS" or namespace_self_test.stderr:
    raise SystemExit("HOSTED_MOUNT_NAMESPACE_SELF_TEST_FAILED")
print("APPLICATION_BOUNDARY_HELPER_BYTES=PASS")
print("APPLICATION_WORKER_BROKER_HQ_BINDING=PASS")
print("HOSTED_POLICY_ROOT_BINDING=PASS")
print("HOSTED_MOUNT_NAMESPACE_STATIC_BINDING=PASS")

acl_deploy_line = next(line for line in deployment_source.splitlines() if line.strip() == "hosted_verify_private_root_acl(runner_uid)")
acl_access_line = next(line for line in deployment_source.splitlines() if "access_text = hosted_sudo(" in line)
acl_default_line = next(line for line in deployment_source.splitlines() if "default_text = hosted_sudo(" in line)
acl_post_probe_line = next(line for line in deployment_source.splitlines() if line.strip() == "after = hosted_protected_state(HOSTED_PRIVATE_ROOT)")

negative_controls = {
    "NO_DEPLOYMENT": (workflow_source.replace("--hosted-deploy", "--hosted-diagnostic", 1), deployment_source, proof_bytes, helper_bytes, worker_source, broker_source),
    "NO_PRIVATE_ROOT": ("\n".join(line for line in workflow_source.splitlines() if 'S8_APP_PRIVATE_ROOT="$(/usr/bin/awk' not in line), deployment_source, proof_bytes, helper_bytes, worker_source, broker_source),
    "NO_POLICY_H": ("\n".join(line for line in workflow_source.splitlines() if 'S8_APP_SANDBOX_POLICY_SHA256="$(/usr/bin/awk' not in line), deployment_source, proof_bytes, helper_bytes, worker_source, broker_source),
    "NO_CONFIG_Q": ("\n".join(line for line in workflow_source.splitlines() if 'S8_APP_CONFIG_SHA256="$(/usr/bin/awk' not in line), deployment_source, proof_bytes, helper_bytes, worker_source, broker_source),
    "DIFFERENT_PRIVATE_ROOT": (workflow_source.replace("/var/lib/swooshz/s8 &&", "/var/lib/swooshz/s8-different &&", 1), deployment_source, proof_bytes, helper_bytes, worker_source, broker_source),
    "DIFFERENT_POLICY_H": (workflow_source.replace('== "$S8_APP_SANDBOX_POLICY_SHA256" ]] || fail_amendment "APPLICATION_POLICY_SNAPSHOT_MISMATCH"', '== "$S8_APP_CONFIG_SHA256" ]] || fail_amendment "APPLICATION_POLICY_SNAPSHOT_MISMATCH"', 1), deployment_source, proof_bytes, helper_bytes, worker_source, broker_source),
    "DIFFERENT_CONFIG_Q": (workflow_source.replace('== "$S8_APP_CONFIG_SHA256" ]] || fail_amendment "APPLICATION_CONFIG_SNAPSHOT_MISMATCH"', '== "$S8_APP_SANDBOX_POLICY_SHA256" ]] || fail_amendment "APPLICATION_CONFIG_SNAPSHOT_MISMATCH"', 1), deployment_source, proof_bytes, helper_bytes, worker_source, broker_source),
    "NO_POLICY_SNAPSHOT_COMPARE": ("\n".join(line for line in workflow_source.splitlines() if "APPLICATION_POLICY_SNAPSHOT_MISMATCH" not in line), deployment_source, proof_bytes, helper_bytes, worker_source, broker_source),
    "NO_APPLICATION_BINDING_MARKER": ("\n".join(line for line in workflow_source.splitlines() if "APPLICATION_CONFIG_Q_BINDING=PASS" not in line), deployment_source, proof_bytes, helper_bytes, worker_source, broker_source),
    "NO_BROKER_BUILD": (workflow_source, deployment_source.replace('hosted_run(["/usr/local/bin/cmake", "--build", str(build)', 'hosted_run(["/usr/local/bin/cmake", "--skip-build", str(build)', 1), proof_bytes, helper_bytes, worker_source, broker_source),
    "NO_HOSTED_CLEANUP": (workflow_source.replace('--hosted-cleanup "$temp_root"', '--hosted-cleanup-disabled "$temp_root"', 1), deployment_source, proof_bytes, helper_bytes, worker_source, broker_source),
    "WORKER_ALTERNATE_LAUNCHER": (workflow_source, deployment_source, proof_bytes, helper_bytes, worker_source.replace("spawnSync(/* turbopackIgnore: true */ launcher, [], {", 'spawnSync("/usr/bin/bwrap", [], {', 1), broker_source),
    "WORKER_SHELL_FALLBACK": (workflow_source, deployment_source, proof_bytes, helper_bytes, worker_source.replace("shell: false", "shell: true", 1), broker_source),
    "DIRECT_BUBBLEWRAP": (workflow_source.replace("/usr/local/libexec/swooshz-s8/s8-sandbox ]] || fail_amendment", "/usr/bin/bwrap ]] || fail_amendment", 1), deployment_source, proof_bytes, helper_bytes, worker_source, broker_source),
    "SOURCE_BEFORE_ADMISSION": (workflow_source.replace(
        "          # RUN107_HOSTED_BROKER_DEPLOYMENT_BEGIN\n",
        '          source "$GITHUB_WORKSPACE/scripts/s8/s8_application_boundary_proof.sh"\n          # RUN107_HOSTED_BROKER_DEPLOYMENT_BEGIN\n',
        1,
    ), deployment_source, proof_bytes, helper_bytes, worker_source, broker_source),
    "HOSTED_POLICY_FIXTURE": (workflow_source, deployment_source.replace('policy_h = hashlib.sha256(hosted_canonical(policy)).hexdigest()', 'policy_h = "a" * 64', 1), proof_bytes, helper_bytes, worker_source, broker_source),
    "HOSTED_CONFIG_FIXTURE": (workflow_source, deployment_source.replace('config_q = hashlib.sha256(hosted_canonical(config)).hexdigest()', 'config_q = "b" * 64', 1), proof_bytes, helper_bytes, worker_source, broker_source),
    "WORKER_RESPONSE_HQ_MISMATCH": (workflow_source, deployment_source, proof_bytes, helper_bytes, worker_source.replace("validateS8BrokerResponseIdentity(response);", "/* identity validation removed */", 1), broker_source),
    "BROKER_REQUEST_HQ_MISMATCH": (workflow_source, deployment_source, proof_bytes, helper_bytes, worker_source, broker_source.replace("constant_equal(request->config_sha256, expected_config, sizeof(expected_config))", "constant_equal(request->policy_sha256, expected_config, sizeof(expected_config))", 1)),
    "PINNED_HELPER_BYTES_MISMATCH": (workflow_source, deployment_source, proof_bytes[:-1] + bytes([proof_bytes[-1] ^ 1]), helper_bytes, worker_source, broker_source),
    "UNPRIVILEGED_PREFLIGHT": (workflow_source, deployment_source.replace("hosted_protected_state(path) is not None for path in absent", "path.exists() or path.is_symlink() for path in absent", 1), proof_bytes, helper_bytes, worker_source, broker_source),
    "UNPRIVILEGED_CLEANUP": (workflow_source, deployment_source.replace('if row["kind"] != "F":\n            continue\n        state = hosted_protected_state(target, digest=True)', 'if row["kind"] != "F":\n            continue\n        state = target.lstat()', 1), proof_bytes, helper_bytes, worker_source, broker_source),
    "UNPRIVILEGED_VISUDO": (workflow_source, deployment_source.replace('hosted_sudo("/usr/sbin/visudo", "-c", "-f", str(HOSTED_SUDOERS), label="HOSTED_SUDOERS_VALIDATION_FAILED")', 'hosted_run(["/usr/sbin/visudo", "-c", "-f", str(HOSTED_SUDOERS)], "HOSTED_SUDOERS_VALIDATION_FAILED")', 1), proof_bytes, helper_bytes, worker_source, broker_source),
    "PERMISSION_AS_ABSENCE": (workflow_source, deployment_source.replace("except FileNotFoundError:", "except OSError:", 1), proof_bytes, helper_bytes, worker_source, broker_source),
    "NOFOLLOW_REMOVED": (workflow_source, deployment_source.replace('os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC', 'os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC', 1), proof_bytes, helper_bytes, worker_source, broker_source),
    "UNPRIVILEGED_DIGEST": (workflow_source, deployment_source.replace('state = hosted_protected_state(path, digest=True)', 'state = os.open(path, os.O_RDONLY)', 1), proof_bytes, helper_bytes, worker_source, broker_source),
    "RAW_TEXT_ACL": (workflow_source, deployment_source.replace(acl_deploy_line, '        if hosted_sudo("/usr/bin/getfacl", "--access", "--", str(HOSTED_PRIVATE_ROOT), label="HOSTED_PRIVATE_ROOT_ACL_READ_FAILED").strip() != "user::rwx":\n            raise HostedDeploymentFailure("HOSTED_PRIVATE_ROOT_ACL_INVALID")', 1), proof_bytes, helper_bytes, worker_source, broker_source),
    "UNPRIVILEGED_ACL_READ": (workflow_source, deployment_source.replace(acl_access_line, '        access_text = HOSTED_PRIVATE_ROOT.read_text(encoding="ascii")', 1), proof_bytes, helper_bytes, worker_source, broker_source),
    "NO_DEFAULT_ACL_READ": (workflow_source, deployment_source.replace(acl_default_line, '        default_text = ""', 1), proof_bytes, helper_bytes, worker_source, broker_source),
    "NO_POST_ACL_IDENTITY": (workflow_source, deployment_source.replace(acl_post_probe_line, '    after = before', 1), proof_bytes, helper_bytes, worker_source, broker_source),
    "EFFECTIVE_RIGHTS_BYPASS": (workflow_source, deployment_source.replace('if reported is not None and reported != derived:', 'if False:', 1), proof_bytes, helper_bytes, worker_source, broker_source),
    "DEFAULT_ACL_ACCEPTED": (workflow_source, deployment_source.replace('or defaults or effective_mismatch', 'or False or effective_mismatch', 1), proof_bytes, helper_bytes, worker_source, broker_source),
}
for label, candidate in negative_controls.items():
    if hosted_binding_accepts(candidate):
        raise SystemExit("HOSTED_COMBINED_BROKER_NEGATIVE_CONTROL_ACCEPTED:" + label)
    print("HOSTED_COMBINED_BROKER_NEGATIVE_CONTROL_" + label + "=PASS")
print("HOSTED_COMBINED_BROKER_APPLICATION_BINDING=PASS")
