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
HOSTED_RUNTIME = Path("/opt/blender")
HOSTED_WRITER_ROOT = Path("/opt/swooshz")
HOSTED_LEDGER_NAME = "s8-broker-deployment.ledger"
HOSTED_DEPLOYMENT_ABSENCE_PATHS = (
    Path("/usr/local/libexec/swooshz-s8"),
    Path("/var/lib/swooshz/s8"),
    Path("/opt/blender"),
    Path("/opt/swooshz"),
    HOSTED_POLICY_PATH,
    HOSTED_SUDOERS,
    HOSTED_SERVICE,
    HOSTED_TIMER,
    HOSTED_LAUNCHER,
    HOSTED_BROKER,
    HOSTED_RUNNER,
    HOSTED_VALIDATOR,
)


class HostedDeploymentFailure(RuntimeError):
    pass


def hosted_run(args, label, *, cwd=None, env=None, log_path=None):
    ledger_path = os.environ.get("S8_PROCESS_LEDGER")
    if ledger_path:
        try:
            from hosted_deployment_namespace import supervised_command
        except ImportError as error:
            raise HostedDeploymentFailure("HOSTED_PROCESS_SUPERVISOR_UNAVAILABLE") from error
        result = supervised_command(args, cwd=cwd, env=env, label=label, log_path=log_path)
    else:
        result = subprocess.run(args, cwd=cwd, env=env, check=False, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        if log_path is not None:
            Path(log_path).write_bytes(result.stdout)
    if result.returncode != 0:
        detail = result.stdout.decode("utf-8", errors="replace")[-12000:]
        raise HostedDeploymentFailure(label + ("\n" + detail if detail else ""))
    return result.stdout.decode("utf-8", errors="strict")


def hosted_run_as_host_user(args, runner_uid, runner_gid, label, *, cwd=None, log_path=None):
    runner_account = pwd.getpwuid(int(runner_uid))
    if runner_account.pw_gid != int(runner_gid):
        raise HostedDeploymentFailure("HOSTED_RUNNER_ACCOUNT_GID_MISMATCH")
    env = {
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "HOME": runner_account.pw_dir,
        "USER": runner_account.pw_name,
        "LOGNAME": runner_account.pw_name,
        "LC_ALL": "C",
    }
    command = [
        "/usr/bin/setpriv", "--reuid", str(runner_uid), "--regid", str(runner_gid),
        "--clear-groups", "--inh-caps=-all", "--ambient-caps=-all", "--bounding-set=-all",
        "--", *args,
    ]
    return hosted_run(command, label, cwd=cwd, env=env, log_path=log_path)


def hosted_root(*args, label="HOSTED_ROOT_COMMAND_FAILED"):
    if os.geteuid() != 0 or os.getuid() != 0:
        raise HostedDeploymentFailure("HOSTED_ROOT_AUTHORITY_REQUIRED")
    return hosted_run(list(args), label)


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


def hosted_protected_state(path, *, digest=False):
    path = Path(path)
    if not path.is_absolute() or ".." in path.parts:
        raise HostedDeploymentFailure("HOSTED_PATH_PROBE_ARGUMENT_INVALID")
    output = hosted_root("/usr/bin/python3", "-c", HOSTED_PATH_STATE_SCRIPT, "digest" if digest else "state", str(path), label="HOSTED_PATH_PROBE_FAILED:" + str(path))
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
    root = Path(os.environ.get("S8_ROOT_STATE", str(temp_root)))
    return root / HOSTED_LEDGER_NAME


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


def hosted_create_directory(temp_root, path, mode, *, record=True):
    if hosted_protected_state(path) is not None:
        raise HostedDeploymentFailure("HOSTED_DIRECTORY_NOT_FRESH:" + str(path))
    hosted_root("/usr/bin/mkdir", "-m", format(mode, "04o"), "--", str(path), label="HOSTED_DIRECTORY_CREATE_FAILED")
    if record:
        try:
            hosted_record_directory(temp_root, path)
        except Exception:
            hosted_root("/usr/bin/rmdir", "--", str(path), label="HOSTED_UNRECORDED_DIRECTORY_CLEANUP_FAILED")
            raise


def hosted_install(temp_root, source, target, mode):
    if hosted_protected_state(target) is not None:
        raise HostedDeploymentFailure("HOSTED_FILE_NOT_FRESH:" + str(target))
    hosted_root("/usr/bin/install", "-o", "root", "-g", "root", "-m", format(mode, "04o"), "--", str(source), str(target), label="HOSTED_FILE_INSTALL_FAILED:" + str(target))
    try:
        hosted_record_file(temp_root, target)
    except Exception:
        hosted_root("/usr/bin/rm", "-f", "--", str(target), label="HOSTED_UNRECORDED_FILE_CLEANUP_FAILED")
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


def hosted_verify_acl_semantics(access_text, default_text, runner_uid, before, after, *, installing=False):
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
    before_mode = 0o700 if installing else 0o710
    identity_match = (
        before is not None and after is not None
        and (before["device"], before["inode"]) == (after["device"], after["inode"])
        and (before["kind"], before["uid"], before["gid"], before["mode"]) == ("directory", 0, 0, before_mode)
        and (after["kind"], after["uid"], after["gid"], after["mode"]) == ("directory", 0, 0, 0o710)
    )
    if access_issues or default_issues or access_rights != expected or defaults or effective_mismatch or not identity_match:
        diagnostic = hosted_acl_diagnostic(access, defaults, after, access_issues + default_issues, effective_mismatch, "SEMANTIC_MISMATCH", identity_match=identity_match)
        raise HostedDeploymentFailure("HOSTED_PRIVATE_ROOT_ACL_INVALID:" + diagnostic)


def hosted_remove_incomplete_private_root(before):
    current = hosted_protected_state(HOSTED_PRIVATE_ROOT)
    if current is None:
        return
    if before is None or (
        current["kind"], current["device"], current["inode"], current["uid"], current["gid"]
    ) != (
        "directory", before["device"], before["inode"], 0, 0
    ):
        raise HostedDeploymentFailure("HOSTED_PRIVATE_ROOT_ROLLBACK_IDENTITY_INVALID")
    mounts = hosted_root(
        "/usr/bin/findmnt", "--noheadings", "--raw", "--output", "TARGET",
        label="HOSTED_PRIVATE_ROOT_ROLLBACK_MOUNT_INSPECTION_FAILED",
    ).splitlines()
    path = str(HOSTED_PRIVATE_ROOT)
    if any(mount == path or mount.startswith(path.rstrip("/") + "/") for mount in mounts):
        raise HostedDeploymentFailure("HOSTED_PRIVATE_ROOT_ROLLBACK_MOUNT_REFUSED")
    contents = hosted_root(
        "/usr/bin/find", "-P", path, "-mindepth", "1", "-maxdepth", "1", "-print", "-quit",
        label="HOSTED_PRIVATE_ROOT_ROLLBACK_CONTENT_INSPECTION_FAILED",
    ).strip()
    if contents:
        raise HostedDeploymentFailure("HOSTED_PRIVATE_ROOT_ROLLBACK_NOT_EMPTY")
    hosted_root("/usr/bin/rmdir", "--", path, label="HOSTED_PRIVATE_ROOT_ROLLBACK_FAILED")
    if hosted_protected_state(HOSTED_PRIVATE_ROOT) is not None:
        raise HostedDeploymentFailure("HOSTED_PRIVATE_ROOT_ROLLBACK_REMAINS")


def hosted_verify_private_root_acl(runner_uid, *, install=False):
    try:
        before = hosted_protected_state(HOSTED_PRIVATE_ROOT)
    except HostedDeploymentFailure as error:
        diagnostic = hosted_acl_diagnostic({}, {}, None, ["PRE_PROBE_FAILED"], [], "PRIVILEGED_IDENTITY_READ_FAILED", identity_match=False)
        raise HostedDeploymentFailure("HOSTED_PRIVATE_ROOT_ACL_IDENTITY_READ_FAILED:" + diagnostic) from error
    expected_mode = 0o700 if install else 0o710
    if before is None or (before["kind"], before["uid"], before["gid"], before["mode"]) != ("directory", 0, 0, expected_mode):
        diagnostic = hosted_acl_diagnostic({}, {}, before, [], [], "PRE_APPLY_IDENTITY_INVALID", identity_match=False)
        raise HostedDeploymentFailure("HOSTED_PRIVATE_ROOT_ACL_INVALID:" + diagnostic)
    try:
        if install:
            acl = f"u::rwx,u:{runner_uid}:--x,g::---,m::--x,o::---"
            try:
                hosted_root("/usr/bin/setfacl", "-k", "--", str(HOSTED_PRIVATE_ROOT), label="HOSTED_PRIVATE_ROOT_ACL_DEFAULT_CLEAR_FAILED")
                hosted_root("/usr/bin/setfacl", "--no-mask", "--set", acl, "--", str(HOSTED_PRIVATE_ROOT), label="HOSTED_PRIVATE_ROOT_ACL_CREATE_FAILED")
                hosted_root("/usr/bin/chmod", "0710", "--", str(HOSTED_PRIVATE_ROOT), label="HOSTED_PRIVATE_ROOT_MODE_SET_FAILED")
            except HostedDeploymentFailure as error:
                diagnostic = hosted_acl_diagnostic({}, {}, before, ["ACL_INSTALL_FAILED"], [], "PRIVILEGED_WRITE_FAILED", identity_match=False)
                raise HostedDeploymentFailure("HOSTED_PRIVATE_ROOT_ACL_CREATE_FAILED:" + diagnostic) from error
        try:
            access_text = hosted_root("/usr/bin/getfacl", "--numeric", "--omit-header", "--absolute-names", "--physical", "--all-effective", "--access", "--", str(HOSTED_PRIVATE_ROOT), label="HOSTED_PRIVATE_ROOT_ACL_ACCESS_READ_FAILED")
        except HostedDeploymentFailure as error:
            diagnostic = hosted_acl_diagnostic({}, {}, before, ["ACCESS_READ_FAILED"], [], "PRIVILEGED_READ_FAILED", identity_match=False)
            raise HostedDeploymentFailure("HOSTED_PRIVATE_ROOT_ACL_READ_FAILED:" + diagnostic) from error
        try:
            default_text = hosted_root("/usr/bin/getfacl", "--numeric", "--omit-header", "--absolute-names", "--physical", "--all-effective", "--default", "--", str(HOSTED_PRIVATE_ROOT), label="HOSTED_PRIVATE_ROOT_ACL_DEFAULT_READ_FAILED")
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
        hosted_verify_acl_semantics(access_text, default_text, runner_uid, before, after, installing=install)
    except Exception as error:
        if install:
            try:
                hosted_remove_incomplete_private_root(before)
            except Exception as rollback_error:
                failure = str(error).split(":", 1)[0]
                rollback = str(rollback_error).split(":", 1)[0]
                raise HostedDeploymentFailure("HOSTED_PRIVATE_ROOT_ACL_ROLLBACK_FAILED:" + failure + ":" + rollback) from error
        if isinstance(error, HostedDeploymentFailure):
            raise
        raise HostedDeploymentFailure("HOSTED_PRIVATE_ROOT_ACL_VERIFY_FAILED") from error


def valid_sudoers_template(source):
    expected = (
        "Cmnd_Alias S8_BROKER_STDIO = ^/usr/local/libexec/swooshz-s8/s8-sandbox-broker$ ^--stdio-v1$",
        'Defaults!S8_BROKER_STDIO env_reset,stay_setuid,!setenv,env_keep="",env_check=""',
        "@S8_HOST_USER@ ALL=(root) NOPASSWD: NOSETENV: S8_BROKER_STDIO",
    )
    return isinstance(source, str) and tuple(source.splitlines()) == expected


def require_sudo_regex_version():
    minimum = (1, 9, 10)
    for executable, label in (("/usr/bin/sudo", "SUDO"), ("/usr/sbin/visudo", "VISUDO")):
        output = hosted_root(executable, "-V", label="HOSTED_" + label + "_VERSION_QUERY_FAILED")
        match = re.search(r"(?m)^(?:Sudo|visudo) version ([0-9]+)\.([0-9]+)\.([0-9]+)(?:p([0-9]+))?\s*$", output)
        if match is None or tuple(int(value or 0) for value in match.groups())[:3] < minimum:
            raise HostedDeploymentFailure("HOSTED_SUDO_REGEX_UNSUPPORTED:" + label)


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
    policy_tmp = Path(os.environ.get("S8_ROOT_STATE", str(temp_root))) / "s8-broker-v1.json"
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
        return None
    metadata = path.lstat()
    if not stat.S_ISREG(metadata.st_mode) or (metadata.st_uid, metadata.st_gid, stat.S_IMODE(metadata.st_mode), metadata.st_nlink) != (os.getuid(), os.getgid(), 0o600, 1):
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


def hosted_verify_deployment_absent():
    present = [str(path) for path in HOSTED_DEPLOYMENT_ABSENCE_PATHS if hosted_protected_state(path) is not None]
    if present:
        raise HostedDeploymentFailure("HOSTED_DEPLOYMENT_RESIDUE_REMAINS:" + ",".join(present))


def hosted_cleanup(temp_root, runner_uid):
    temp_root = Path(temp_root)
    rows = hosted_load_ledger(temp_root)
    if rows is None:
        hosted_verify_deployment_absent()
        print("BROKER_DEPLOYMENT_CLEANUP=PASS_NO_LEDGER")
        print("PRODUCTION_DEPLOYMENT_ABSENT=YES")
        return
    private_root_state = hosted_protected_state(HOSTED_PRIVATE_ROOT)
    if private_root_state is not None:
        hosted_verify_private_root_acl(runner_uid)
    journal = HOSTED_PRIVATE_ROOT / ".journal"
    journal_state = hosted_protected_state(journal)
    if journal_state is not None:
        broker_state = hosted_protected_state(HOSTED_BROKER)
        policy_state = hosted_protected_state(HOSTED_POLICY_PATH)
        if broker_state is None or broker_state["kind"] != "regular" or policy_state is None or policy_state["kind"] != "regular":
            raise HostedDeploymentFailure("HOSTED_RECOVERY_INPUTS_INVALID")
        hosted_root(str(HOSTED_BROKER), "--recover-v1", label="HOSTED_BROKER_RECOVERY_FAILED")
        journal_state = hosted_protected_state(journal)
        if journal_state is None or (journal_state["kind"], journal_state["uid"], journal_state["gid"], journal_state["mode"]) != ("directory", 0, 0, 0o700):
            raise HostedDeploymentFailure("HOSTED_JOURNAL_IDENTITY_INVALID")
        extra = hosted_root("/usr/bin/find", "-P", str(journal), "-mindepth", "1", "-maxdepth", "1", "!", "-name", ".lock", "-print", "-quit", label="HOSTED_JOURNAL_INSPECTION_FAILED").strip()
        if extra:
            raise HostedDeploymentFailure("HOSTED_JOURNAL_UNEXPECTED_CONTENT")
        lock = journal / ".lock"
        lock_state = hosted_protected_state(lock)
        if lock_state is not None:
            if (lock_state["kind"], lock_state["uid"], lock_state["gid"], lock_state["mode"], lock_state["nlink"]) != ("regular", 0, 0, 0o600, 1):
                raise HostedDeploymentFailure("HOSTED_JOURNAL_LOCK_IDENTITY_INVALID")
            hosted_root("/usr/bin/rm", "-f", "--", str(lock), label="HOSTED_JOURNAL_LOCK_CLEANUP_FAILED")
        hosted_root("/usr/bin/rmdir", "--", str(journal), label="HOSTED_JOURNAL_CLEANUP_FAILED")

    for row in reversed(rows):
        target = Path(row["path"])
        if row["kind"] != "F":
            continue
        state = hosted_protected_state(target, digest=True)
        if state["kind"] != "regular" or hosted_identity(state) != row["identity"]:
            raise HostedDeploymentFailure("HOSTED_FILE_CLEANUP_IDENTITY_INVALID:" + str(target))
        if state["sha256"] != row["digest"]:
            raise HostedDeploymentFailure("HOSTED_FILE_CLEANUP_HASH_INVALID:" + str(target))
        hosted_root("/usr/bin/rm", "-f", "--", str(target), label="HOSTED_FILE_CLEANUP_FAILED")
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
            hosted_root("/usr/bin/rm", "-rf", "--", str(target), label="HOSTED_RUNTIME_CLEANUP_FAILED")
        else:
            hosted_root("/usr/bin/rmdir", "--", str(target), label="HOSTED_DIRECTORY_CLEANUP_FAILED")
        if hosted_protected_state(target) is not None:
            raise HostedDeploymentFailure("HOSTED_DIRECTORY_REMAINS:" + str(target))
    hosted_verify_deployment_absent()
    hosted_ledger(temp_root).unlink()
    if hosted_ledger(temp_root).exists() or hosted_ledger(temp_root).is_symlink():
        raise HostedDeploymentFailure("HOSTED_LEDGER_CLEANUP_FAILED")
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
    if temp_meta is None or not stat.S_ISDIR(temp_meta.st_mode) or temp_root.is_symlink() or (temp_meta.st_uid, temp_meta.st_gid, stat.S_IMODE(temp_meta.st_mode)) != (int(runner_uid), int(runner_gid), 0o700):
        raise HostedDeploymentFailure("HOSTED_TEMP_ROOT_IDENTITY_INVALID")
    if os.geteuid() != 0 or os.getuid() != 0:
        raise HostedDeploymentFailure("HOSTED_DEPLOYMENT_ROOT_SUPERVISOR_REQUIRED")
    if not re.fullmatch(r"[1-9][0-9]*", runner_uid) or not re.fullmatch(r"[1-9][0-9]*", runner_gid):
        raise HostedDeploymentFailure("HOSTED_RUNNER_IDENTITY_INVALID")
    try:
        runner_account = pwd.getpwuid(int(runner_uid))
    except KeyError as error:
        raise HostedDeploymentFailure("HOSTED_RUNNER_ACCOUNT_MISSING") from error
    if runner_account.pw_gid != int(runner_gid):
        raise HostedDeploymentFailure("HOSTED_RUNNER_ACCOUNT_GID_MISMATCH")
    runner_name = runner_account.pw_name
    if not re.fullmatch(r"[a-z_][a-z0-9_-]*\$?", runner_name):
        raise HostedDeploymentFailure("HOSTED_RUNNER_NAME_INVALID")
    ledger = hosted_ledger(temp_root)
    if ledger.exists() or ledger.is_symlink():
        raise HostedDeploymentFailure("HOSTED_LEDGER_PREEXISTENCE")
    descriptor = os.open(ledger, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    os.close(descriptor)
    try:
        root_state = Path(os.environ.get("S8_ROOT_STATE", str(temp_root)))
        build = temp_root / "s8-broker-build"
        if hosted_protected_state(build) is not None:
            raise HostedDeploymentFailure("HOSTED_BROKER_BUILD_PATH_NOT_FRESH")
        runner_cmake_log = root_state / "broker-cmake-configure.log"
        hosted_run_as_host_user(["/usr/local/bin/cmake", "-S", str(workspace / "native/s8-sandbox-broker"), "-B", str(build), "-DCMAKE_BUILD_TYPE=Release"], runner_uid, runner_gid, "BROKER_CMAKE_CONFIGURE_FAILED", cwd=workspace, log_path=runner_cmake_log)
        hosted_run_as_host_user(["/usr/local/bin/cmake", "--build", str(build), "--config", "Release", "--parallel"], runner_uid, runner_gid, "BROKER_BUILD_FAILED", cwd=workspace, log_path=root_state / "broker-build.log")
        hosted_run_as_host_user(["/usr/local/bin/ctest", "--test-dir", str(build), "--output-on-failure"], runner_uid, runner_gid, "BROKER_TESTS_FAILED", cwd=workspace, log_path=root_state / "broker-ctest.log")
        broker_build = build / "s8-sandbox-broker"
        broker_build_meta = broker_build.lstat() if broker_build.exists() or broker_build.is_symlink() else None
        if broker_build_meta is None or not stat.S_ISREG(broker_build_meta.st_mode) or broker_build.is_symlink() or (broker_build_meta.st_uid, broker_build_meta.st_gid, broker_build_meta.st_nlink, stat.S_IMODE(broker_build_meta.st_mode)) != (int(runner_uid), int(runner_gid), 1, 0o755):
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
        hosted_create_directory(temp_root, HOSTED_PRIVATE_ROOT, 0o700, record=False)
        private_root_before = hosted_protected_state(HOSTED_PRIVATE_ROOT)
        if private_root_before is None:
            raise HostedDeploymentFailure("HOSTED_PRIVATE_ROOT_CREATE_IDENTITY_MISSING")
        hosted_create_directory(temp_root, Path("/etc/swooshz"), 0o755)

        hosted_verify_private_root_acl(runner_uid, install=True)
        try:
            hosted_record_directory(temp_root, HOSTED_PRIVATE_ROOT)
        except Exception:
            hosted_remove_incomplete_private_root(private_root_before)
            raise

        source_runtime = carrier / "runtime/blender-5.2.2-linux-x64"
        hosted_root("/usr/bin/cp", "-a", "--no-dereference", "--", str(source_runtime) + "/.", str(HOSTED_RUNTIME) + "/", label="HOSTED_RUNTIME_COPY_FAILED")
        hosted_root("/usr/bin/chown", "-R", "--no-dereference", "root:root", "--", str(HOSTED_RUNTIME), label="HOSTED_RUNTIME_OWNER_FAILED")
        for args, label in ((["-type", "d", "-exec", "/usr/bin/chmod", "0755", "--", "{}", "+"], "HOSTED_RUNTIME_DIRECTORY_MODE_FAILED"), (["-type", "f", "-perm", "/111", "-exec", "/usr/bin/chmod", "0755", "--", "{}", "+"], "HOSTED_RUNTIME_EXECUTABLE_MODE_FAILED"), (["-type", "f", "!", "-perm", "/111", "-exec", "/usr/bin/chmod", "0644", "--", "{}", "+"], "HOSTED_RUNTIME_DATA_MODE_FAILED")):
            hosted_root("/usr/bin/find", "-P", str(HOSTED_RUNTIME), *args, label=label)

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
        if not valid_sudoers_template(sudoers_source) or sudoers_source.count("@S8_HOST_USER@") != 1:
            raise HostedDeploymentFailure("HOSTED_SUDOERS_TEMPLATE_INVALID")
        sudoers_tmp = root_state / "swooshz-s8-broker.sudoers"
        sudoers_tmp.write_text(sudoers_source.replace("@S8_HOST_USER@", runner_name), encoding="ascii")
        sudoers_tmp.chmod(0o600)
        hosted_install(temp_root, sudoers_tmp, HOSTED_SUDOERS, 0o440)
        require_sudo_regex_version()
        hosted_root("/usr/sbin/visudo", "-c", "-f", "/etc/sudoers", label="HOSTED_SUDOERS_VALIDATION_FAILED")

        policy_tmp, policy_h, config_q, policy_file_hash = hosted_policy(temp_root, int(runner_uid), int(runner_gid))
        hosted_install(temp_root, policy_tmp, HOSTED_POLICY_PATH, 0o600)
        if hosted_file_digest(HOSTED_POLICY_PATH, 0o600) != policy_file_hash:
            raise HostedDeploymentFailure("HOSTED_POLICY_INSTALL_HASH_MISMATCH")
        hosted_root(str(HOSTED_BROKER), "--recover-v1", label="HOSTED_BROKER_POLICY_ADMISSION_FAILED")
        print("BROKER_BUILD=PASS")
        print("BROKER_TESTS=PASS")
        print("HOSTED_BROKER_BUILD_WIRING=PASS")
        print("HOSTED_BROKER_DEPLOYMENT=PASS")
        print("HOSTED_PRIVATE_ROOT=PASS")
        print("HOSTED_POLICY_GENERATION=PASS")
        print("POLICY_CANONICAL_ROUNDTRIP=PASS")
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
            hosted_cleanup(temp_root, runner_uid)
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
        elif mode == "--hosted-cleanup" and len(sys.argv) == 4:
            hosted_cleanup(sys.argv[2], sys.argv[3])
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
    original_sudo = hosted_root
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

            globals()["hosted_root"] = local_sudo
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

            globals()["hosted_root"] = denied_sudo
            try:
                hosted_protected_state(root / "missing")
            except HostedDeploymentFailure as error:
                if str(error) != "HOSTED_PATH_PROBE_PERMISSION_DENIED":
                    raise
            else:
                raise SystemExit("HOSTED_PATH_PROBE_PERMISSION_AS_ABSENCE")

            def malformed_sudo(*args, label):
                return '{"state":"absent","uncertain":true}\n'

            globals()["hosted_root"] = malformed_sudo
            try:
                hosted_protected_state(root / "missing")
            except HostedDeploymentFailure:
                pass
            else:
                raise SystemExit("HOSTED_PATH_PROBE_MALFORMED_ACCEPTED")
    finally:
        globals()["hosted_root"] = original_sudo
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

    original_sudo, original_probe = hosted_root, hosted_protected_state
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
        globals()["hosted_root"] = fake_sudo
        hosted_verify_private_root_acl(runner_uid)
        if len(calls) != 4 or calls[0] != "probe" or calls[-1] != "probe" or calls[1][0] != "/usr/bin/getfacl" or "--access" not in calls[1] or "--default" not in calls[2] or any("--physical" not in args or "--absolute-names" not in args for args in calls[1:3]):
            raise SystemExit("HOSTED_ACL_PRIVILEGED_ROUTE_INVALID")

        install_calls = []
        probe_calls = [0]

        def fresh_then_final_probe(path):
            if path != HOSTED_PRIVATE_ROOT:
                raise SystemExit("HOSTED_ACL_INSTALL_PROBE_TARGET_INVALID")
            probe_calls[0] += 1
            install_calls.append("probe")
            return dict(state, mode=0o700 if probe_calls[0] == 1 else 0o710)

        def fake_install_root(*args, label):
            install_calls.append(args)
            if args[0] == "/usr/bin/setfacl" or args[0] == "/usr/bin/chmod":
                return ""
            if args[0] == "/usr/bin/getfacl" and "--access" in args:
                return reordered
            if args[0] == "/usr/bin/getfacl" and "--default" in args:
                return ""
            raise SystemExit("HOSTED_ACL_INSTALL_PRIVILEGED_ROUTE_INVALID")

        globals()["hosted_root"] = fake_install_root
        globals()["hosted_protected_state"] = fresh_then_final_probe
        hosted_verify_private_root_acl(runner_uid, install=True)
        install_commands = [call for call in install_calls if call != "probe"]
        if len(install_calls) != 7 or len(install_commands) != 5 or install_commands[0][:2] != ("/usr/bin/setfacl", "-k") or "--no-mask" not in install_commands[1] or not any("g::---" in argument for argument in install_commands[1]) or install_commands[2][:2] != ("/usr/bin/chmod", "0710"):
            raise SystemExit("HOSTED_ACL_INSTALL_PRIVILEGED_ROUTE_INVALID")
        rollback_exists = [True]
        rollback_calls = []

        def rollback_probe(path):
            if path != HOSTED_PRIVATE_ROOT:
                raise SystemExit("HOSTED_ACL_ROLLBACK_PROBE_TARGET_INVALID")
            rollback_calls.append("probe")
            return dict(state, mode=0o700) if rollback_exists[0] else None

        def partial_acl_install(*args, label):
            rollback_calls.append(args)
            if args[0] == "/usr/bin/setfacl" and args[1] == "-k":
                return ""
            if args[0] == "/usr/bin/setfacl" and "--set" in args:
                raise HostedDeploymentFailure("PRIVATE_ACL_INSTALL_FAILURE")
            if args[0] == "/usr/bin/findmnt":
                return ""
            if args[0] == "/usr/bin/find":
                return ""
            if args[0] == "/usr/bin/rmdir" and args[-1] == str(HOSTED_PRIVATE_ROOT):
                rollback_exists[0] = False
                return ""
            raise SystemExit("HOSTED_ACL_ROLLBACK_ROUTE_INVALID")

        globals()["hosted_root"] = partial_acl_install
        globals()["hosted_protected_state"] = rollback_probe
        try:
            hosted_verify_private_root_acl(runner_uid, install=True)
        except HostedDeploymentFailure as error:
            if not str(error).startswith("HOSTED_PRIVATE_ROOT_ACL_CREATE_FAILED:"):
                raise SystemExit("HOSTED_ACL_PARTIAL_INSTALL_DIAGNOSTIC_INVALID")
        else:
            raise SystemExit("HOSTED_ACL_PARTIAL_INSTALL_FALSE_GREEN")
        rollback_commands = [call for call in rollback_calls if call != "probe"]
        if rollback_exists[0] or not any(call[0] == "/usr/bin/findmnt" for call in rollback_commands) or not any(call[0] == "/usr/bin/find" for call in rollback_commands) or not any(call[0] == "/usr/bin/rmdir" for call in rollback_commands):
            raise SystemExit("HOSTED_ACL_PARTIAL_INSTALL_ROLLBACK_MISSING")
        print("HOSTED_ACL_PARTIAL_INSTALL_ROLLBACK=PASS")
        globals()["hosted_root"] = fake_sudo
        globals()["hosted_protected_state"] = fake_probe

        def denied_read(*args, label):
            if args[0] == "/usr/bin/getfacl":
                raise HostedDeploymentFailure("PRIVATE_UNTRUSTED_TOOL_OUTPUT")
            return ""

        globals()["hosted_root"] = denied_read
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

        globals()["hosted_root"] = denied_default
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

        globals()["hosted_root"] = fake_sudo
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
        globals()["hosted_root"] = original_sudo
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
deployment_path = Path(__file__).resolve()
supervisor_path = repo_root / "native/s8-sandbox-broker/tests/hosted_deployment_namespace.py"
sudoers_path = repo_root / "native/s8-sandbox-broker/deploy/swooshz-s8-broker.sudoers.in"


def valid_hosted_protected_harness(deployment, supervisor):
    try:
        deployment_tree = ast.parse(deployment)
        supervisor_tree = ast.parse(supervisor)
        probe_source = deployment.split("HOSTED_PATH_STATE_SCRIPT = r'''", 1)[1].split("'''", 1)[0]
        probe_tree = ast.parse(probe_source)
    except (SyntaxError, IndexError):
        return False
    if probe_source.count("os.O_NOFOLLOW") != 3 or probe_source.count("follow_symlinks=False") != 2:
        return False
    probe_handlers = [node for node in ast.walk(probe_tree) if isinstance(node, ast.ExceptHandler)]
    if len(probe_handlers) != 1 or not isinstance(probe_handlers[0].type, ast.Name) or probe_handlers[0].type.id != "FileNotFoundError":
        return False
    if any(isinstance(node, ast.Name) and node.id == "hosted_sudo" for node in ast.walk(deployment_tree)) or any(isinstance(node, ast.Name) and node.id == "hosted_sudo" for node in ast.walk(supervisor_tree)):
        return False
    dep = {node.name: node for node in deployment_tree.body if isinstance(node, ast.FunctionDef)}
    sup = {node.name: node for node in supervisor_tree.body if isinstance(node, ast.FunctionDef)}
    def assignment_text(tree, source, name):
        for node in tree.body:
            if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == name for target in node.targets):
                return ast.get_source_segment(source, node)
        return None

    if assignment_text(deployment_tree, deployment, "HOSTED_RUNTIME") != 'HOSTED_RUNTIME = Path("/opt/blender")':
        return False
    if assignment_text(deployment_tree, deployment, "HOSTED_WRITER_ROOT") != 'HOSTED_WRITER_ROOT = Path("/opt/swooshz")':
        return False
    if assignment_text(supervisor_tree, supervisor, "ROUTE_B_PRODUCT_LEAF_NAMES") != 'ROUTE_B_PRODUCT_LEAF_NAMES = ("blender", "swooshz")':
        return False
    absence_assignment = next((
        node for node in deployment_tree.body
        if isinstance(node, ast.Assign)
        and any(isinstance(target, ast.Name) and target.id == "HOSTED_DEPLOYMENT_ABSENCE_PATHS" for target in node.targets)
    ), None)
    absence_source = ast.get_source_segment(deployment, absence_assignment) if absence_assignment is not None else None
    if absence_source is None or any(token not in absence_source for token in ('Path("/opt/blender")', 'Path("/opt/swooshz")')):
        return False
    owned_class = next((node for node in supervisor_tree.body if isinstance(node, ast.ClassDef) and node.name == "OwnedProcess"), None)
    if owned_class is None:
        return False
    owned_methods = {node.name: node for node in owned_class.body if isinstance(node, ast.FunctionDef)}
    signal_body = ast.get_source_segment(supervisor, owned_methods.get("signal")) if owned_methods.get("signal") is not None else None
    wait_body = ast.get_source_segment(supervisor, owned_methods.get("wait")) if owned_methods.get("wait") is not None else None
    if signal_body is None or any(token not in signal_body for token in (
        "expected_identity != self.start_identity", "self.identity_valid()", "signal.pidfd_send_signal(self.pidfd, signum)",
        "except ProcessLookupError:", "PIDFD_SIGNAL_FAILED",
    )) or "os.kill(self.pid, signum)" in signal_body:
        return False
    if wait_body is None or any(token not in wait_body for token in (
        "self.process.wait(timeout=timeout)", "self.terminal = result", "write_ledger(self._ledger_path", "os.close(self.pidfd)",
    )):
        return False

    def body(table, source, name):
        node = table.get(name)
        return ast.get_source_segment(source, node) if node is not None else None

    deployment_requirements = {
        "hosted_root": ("os.geteuid() != 0 or os.getuid() != 0", "return hosted_run(list(args), label)"),
        "hosted_protected_state": ('hosted_root("/usr/bin/python3", "-c", HOSTED_PATH_STATE_SCRIPT',),
        "hosted_remove_incomplete_private_root": (
            'current["device"], current["inode"]', "HOSTED_PRIVATE_ROOT_ROLLBACK_MOUNT_REFUSED",
            '"/usr/bin/find"', "HOSTED_PRIVATE_ROOT_ROLLBACK_NOT_EMPTY",
            '"/usr/bin/rmdir"', "HOSTED_PRIVATE_ROOT_ROLLBACK_REMAINS",
        ),
        "hosted_verify_private_root_acl": (
            'hosted_root("/usr/bin/setfacl", "-k"',
            'hosted_root("/usr/bin/setfacl", "--no-mask", "--set", acl',
            '"--all-effective", "--access"', '"--all-effective", "--default"',
            "hosted_verify_acl_semantics(access_text, default_text, runner_uid, before, after, installing=install)",
            "hosted_remove_incomplete_private_root(before)",
        ),
        "hosted_verify_deployment_absent": (
            "HOSTED_DEPLOYMENT_ABSENCE_PATHS", "HOSTED_DEPLOYMENT_RESIDUE_REMAINS",
        ),
        "hosted_create_directory": (
            "hosted_protected_state(path) is not None", 'hosted_root("/usr/bin/mkdir"',
            "hosted_record_directory(temp_root, path)",
            'hosted_root("/usr/bin/rmdir", "--", str(path)',
        ),
        "hosted_verify_acl_semantics": (
            '"user:": "rwx"', '"user:" + str(runner_uid): "--x"', '"group:": "---"',
            '"mask:": "--x"', '"other:": "---"',
            "access_rights != expected or defaults or effective_mismatch or not identity_match",
        ),
        "valid_sudoers_template": (
            "Cmnd_Alias S8_BROKER_STDIO", "stay_setuid,!setenv,env_keep=", "NOPASSWD: NOSETENV: S8_BROKER_STDIO",
        ),
        "require_sudo_regex_version": (
            "minimum = (1, 9, 10)", '("/usr/bin/sudo", "SUDO")', '("/usr/sbin/visudo", "VISUDO")',
        ),
        "hosted_cleanup": (
            'hosted_root(str(HOSTED_BROKER), "--recover-v1"', "hosted_load_ledger(temp_root)",
            "hosted_verify_private_root_acl(runner_uid)", "HOSTED_NESTED_MOUNT_REFUSED",
            "for row in reversed(rows):", 'if row["kind"] != "D":',
            'if str(target) == "/opt/blender":',
            'hosted_root("/usr/bin/rm", "-rf", "--", str(target)',
            'hosted_root("/usr/bin/rmdir", "--", str(target)',
            "HOSTED_DIRECTORY_CLEANUP_IDENTITY_INVALID", "HOSTED_DIRECTORY_REMAINS",
            "hosted_verify_deployment_absent()", "PRODUCTION_DEPLOYMENT_ABSENT=YES",
        ),
        "hosted_deploy": (
            "if any(hosted_protected_state(path) is not None for path in absent):",
            '"/opt/blender"', '"/opt/swooshz"', "HOSTED_DEPLOYMENT_PATH_NOT_FRESH",
            "hosted_create_directory(temp_root, HOSTED_RUNTIME, 0o755)",
            "hosted_create_directory(temp_root, HOSTED_WRITER_ROOT, 0o755)",
            'hosted_run_as_host_user(["/usr/local/bin/cmake", "-S"',
            'hosted_run_as_host_user(["/usr/local/bin/cmake", "--build"',
            'hosted_run_as_host_user(["/usr/local/bin/ctest", "--test-dir"',
            "private_root_before = hosted_protected_state(HOSTED_PRIVATE_ROOT)",
        "hosted_verify_private_root_acl(runner_uid, install=True)",
        "hosted_remove_incomplete_private_root(private_root_before)",
            'hosted_root("/usr/sbin/visudo", "-c", "-f", "/etc/sudoers"',
            'hosted_root(str(HOSTED_BROKER), "--recover-v1"',
            'print("HOSTED_POLICY_H=" + policy_h)', 'print("HOSTED_CONFIG_Q=" + config_q)',
        ),
    }
    for name, tokens in deployment_requirements.items():
        source = body(dep, deployment, name)
        if source is None or any(token not in source for token in tokens):
            return False
    cleanup_body = body(dep, deployment, "hosted_cleanup")
    if cleanup_body is None or cleanup_body.count("hosted_verify_deployment_absent()") != 2:
        return False
    run_as_user = body(dep, deployment, "hosted_run_as_host_user")
    if run_as_user is None or "setpriv" not in run_as_user or "--clear-groups" not in run_as_user:
        return False
    if "hosted_root(str(HOSTED_BROKER), \"--recover-v1\"" not in body(dep, deployment, "hosted_deploy"):
        return False

    supervisor_requirements = {
        "launch_owned": ("os.pidfd_open(process.pid, 0)", "process_start_identity(process.pid)", "OwnedProcess(process"),
        "terminate_owned": ("signal.SIGTERM", "signal.SIGKILL", "owned.wait(grace)"),
        "namespace_processes": ("process_start_identity(pid) != start_identity", "mnt:[{namespace_number}]", "NAMESPACE_REFERENCE_SCAN_UNREADABLE"),
        "run_sudo_matrix": (
            "SUDO_EXACT_STDIO_POSITIVE", "--recover-v1", "ALTERNATE_COPY", "ALTERNATE_SYMLINK",
            "WRONG_RUNAS", "PRESERVE_ENV", "ENV_ASSIGNMENT", "WRONG_CALLER", "protected_snapshot() != before",
            'tempfile.TemporaryDirectory(prefix="s8-sudo-matrix-"', "SUDO_MATRIX_SOURCE_BROKER_IDENTITY_INVALID",
            "O_EXCL | os.O_NOFOLLOW", "matrix_root.iterdir()", "SUDO_MATRIX_ROOT_CLEANUP_IDENTITY_INVALID",
            "def replace_policy(mutated, label)", "os.fsync(descriptor)", "sudoers_identity",
        ),
        "observe_application_targets": (
            "process_start_identity(pid)", "process_uid_gid(pid)", "variables != [b\"PWD=/work\"]", "PermissionError",
        ),
        "application_source_identity_matches": (
            "len(proof_bytes) == APP_PROOF_BYTES", "hashlib.sha256(proof_bytes).hexdigest() == APP_PROOF_SHA256",
            "len(helper_bytes) == APP_HELPER_BYTES", "hashlib.sha256(helper_bytes).hexdigest() == APP_HELPER_SHA256",
        ),
        "application_proof": (
            "APP_PROOF_RELATIVE", "APP_HELPER_RELATIVE", "proof_path.read_bytes()", "helper_path.read_bytes()",
            "application_source_identity_matches(proof_bytes, helper_bytes)", "app_identity_command(uid, gid",
            "observe_application_targets", "APPLICATION_SEMANTIC_READBACK=PASS",
            "application_source_identity_matches(", "APPLICATION_HELPER_BYTES_CHANGED_DURING_RUN",
            "PRODUCTION_BOUNDARY_PROOF=PASS", "APPLICATION_PROOF_MTS_AS_EXACT_HOST_USER=PASS",
        ),
        "create_namespace_sudoers": ("/etc/sudoers", "/etc/sudoers.d", "NAMESPACE_SUDOERS_POLICY_MOUNT_INVALID"),
        "opt_snapshot": ("validate_outer_opt_path_mode(before.st_mode)", "system.posix_acl_access", "system.posix_acl_default", "normalize_opt_mount_view(rows)"),
        "validate_outer_opt_path_mode": ("OUTER_OPT_SYMLINK", "OUTER_OPT_NOT_DIRECTORY"),
        "hosted_node_toolcache_installation": ("HOSTED_NODE_TOOLCACHE_ROOT", "22\\.[0-9]+\\.[0-9]+", "parts[1] != \"x64\"", "HOSTED_TOOLCHAIN_SOURCE_OUTSIDE_NODE_TOOLCACHE"),
        "derive_toolchain_plan": ("os.path.commonpath", "minimal_source.relative_to(node_installation)", "HOSTED_TOOLCHAIN_SOURCE_NOT_MINIMAL", "HOSTED_TOOLCHAIN_DESTINATION_INVALID"),
        "validate_toolchain_identity": ("HOSTED_TOOLCHAIN_IDENTITY_INVALID", "HOSTED_TOOLCHAIN_IDENTITY_CHANGED", "sha256"),
        "verify_toolchain": ("validate_toolchain_identity(expected[\"node\"], node_identity)", "validate_toolchain_identity(expected[\"corepack\"], corepack_identity)", "HOSTED_NODE_VERSION_INVALID", "HOSTED_PNPM_VERSION_INVALID", "12.6.0"),
        "validate_toolchain_staging_identity": ("HOSTED_TOOLCHAIN_STAGING_PATH_INVALID", "HOSTED_TOOLCHAIN_STAGING_IDENTITY_CHANGED", "expected_identity != observed_identity"),
        "validate_toolchain_bind": ("HOSTED_TOOLCHAIN_BIND_IDENTITY_MISMATCH", "HOSTED_TOOLCHAIN_BIND_DESTINATION_INVALID", "os.major", "os.minor", "ro", "nosuid", "nodev", "noexec"),
        "private_opt_mount": ("mount_namespace_private()", "current_outer = opt_snapshot()", "validate_outer_opt_snapshot", "validate_inner_opt_mount", "/usr/bin/mount", "tmpfs", "/opt", "toolchain_identity(node)", "derive_toolchain_plan", "validate_unpreserved_toolchain_missing(node_missing, corepack_missing)", "--bind", "remount,bind,ro,nosuid,nodev", "validate_toolchain_bind", "verify_toolchain(node, corepack, workspace=workspace, expected=", "HOSTED_TOOLCHAIN_PREMOUNT_IDENTITY=PASS", "HOSTED_TOOLCHAIN_STAGING_BIND=PASS", "HOSTED_TOOLCHAIN_NO_PRESERVATION=REPRODUCED_MISSING", "HOSTED_TOOLCHAIN_INNER_BIND=READ_ONLY", "HOSTED_TOOLCHAIN_STAGING_UNMOUNT=PASS", "HOSTED_TOOLCHAIN_IDENTITY_CONTINUITY=PASS", "validate_toolchain_staging_identity(stage_target, staged_identity, post_mount_staging_identity)", "stagingIdentityAfterOverlay=post_mount_staging_identity", 'inner_identity["defaultAcl"] = default_acl', 'toolchain["innerOptIdentity"] = inner_identity'),
        "route_b_path_identity": ("Path(path).lstat()", "stat.S_ISLNK", "metadata.st_ino", "metadata.st_dev", "metadata.st_uid", "metadata.st_gid"),
        "route_b_product_leaf_paths": ("ROUTE_B_PRODUCT_LEAF_NAMES", "root / name"),
        "validate_trusted_inner_opt_identity": ("ROUTE_B_INNER_OPT_IDENTITY_CHANGED", "defaultAcl", "system.posix_acl_default"),
        "validate_product_leaf_absence_state": ("file_type is not None or is_mountpoint", "HOSTED_PRODUCT_LEAF_NOT_FRESH"),
        "validate_product_leaves_absent": ("validate_trusted_inner_opt_identity", "route_b_product_leaf_paths", "route_b_path_identity", "mountinfo_rows", "validate_product_leaf_absence_state"),
        "validate_product_leaf_identity": ("ROUTE_B_PRODUCT_LEAF_PATH_INVALID", "ROUTE_B_PRODUCT_LEAF_TYPE_INVALID", "ROUTE_B_PRODUCT_LEAF_DEVICE_INVALID", "ROUTE_B_PRODUCT_LEAF_OWNER_INVALID", "ROUTE_B_PRODUCT_LEAF_MODE_INVALID", "ROUTE_B_PRODUCT_LEAF_DEFAULT_ACL_INVALID", "0o755"),
        "validate_product_leaves_deployed": ("validate_trusted_inner_opt_identity", "ROUTE_B_PRODUCT_LEAF_MOUNTPOINT_INVALID", "ROUTE_B_PRODUCT_LEAF_MISSING", "route_b_path_identity", "acl_state(", "validate_product_leaf_identity"),
        "create_toolchain_stage_root": ("tempfile.mkdtemp(prefix=\"toolchain-stage-\"", "0o700", "HOSTED_TOOLCHAIN_STAGE_PARENT_INVALID"),
        "cleanup_toolchain_stage_root": ("validate_toolchain_namespace_release(namespace_closed)", "HOSTED_TOOLCHAIN_STAGE_MOUNT_REFERENCE_REMAINS", "root.rmdir()"),
        "validate_toolchain_preservation_events": ("PREMOUNT_IDENTITY", "STAGING_BIND", "NO_BIND_NEGATIVE", "INNER_BIND", "STAGING_RELEASED", "CONTINUITY", "HOSTED_TOOLCHAIN_RESOURCE_LEDGER_INVALID", 'inner.get("stagingIdentityAfterOverlay") != staged_identity'),
        "validate_toolchain_namespace_release": ("HOSTED_TOOLCHAIN_NAMESPACE_REFERENCE_REMAINS",),
        "validate_unpreserved_toolchain_missing": ("HOSTED_TOOLCHAIN_NO_PRESERVATION_NEGATIVE_FALSE_GREEN",),
        "create_inner_toolchain_parent_directories": ("HOSTED_TOOLCHAIN_DESTINATION_PARENT_NOT_FRESH", "validate_inner_opt_child", "os.chmod(path, 0o755)"),
        "run_toolchain_preservation_controls": ("HOSTED_TOOLCHAIN_CONTROL_MINIMAL_SUBTREE_SELECTED", "HOSTED_TOOLCHAIN_CONTROL_WRONG_SOURCE_SUBTREE_REJECTED", "HOSTED_TOOLCHAIN_CONTROL_BROAD_OPT_BIND_REJECTED", "HOSTED_TOOLCHAIN_CONTROL_UNRELATED_TOOLCACHE_REJECTED", "HOSTED_TOOLCHAIN_CONTROL_WRONG_DESTINATION_REJECTED", "HOSTED_TOOLCHAIN_CONTROL_DIFFERENT_SOURCE_STAGE_PATHS_ACCEPTED", "HOSTED_TOOLCHAIN_CONTROL_STAGING_IDENTITY_CONTINUITY_ACCEPTED", "HOSTED_TOOLCHAIN_CONTROL_STAGING_DEVICE_CHANGE_REJECTED", "HOSTED_TOOLCHAIN_CONTROL_STAGING_INODE_CHANGE_REJECTED", "HOSTED_TOOLCHAIN_CONTROL_STAGING_UID_CHANGE_REJECTED", "HOSTED_TOOLCHAIN_CONTROL_STAGING_GID_CHANGE_REJECTED", "HOSTED_TOOLCHAIN_CONTROL_STAGING_MODE_CHANGE_REJECTED", "HOSTED_TOOLCHAIN_CONTROL_WRONG_STAGING_PATH_REJECTED", "HOSTED_TOOLCHAIN_CONTROL_WRONG_STAGING_ROLE_REJECTED", "HOSTED_TOOLCHAIN_CONTROL_SOURCE_IDENTITY_CHANGE_REJECTED", "HOSTED_TOOLCHAIN_CONTROL_WRONG_ORIGINAL_SOURCE_OBJECT_REJECTED", "HOSTED_TOOLCHAIN_CONTROL_SOURCE_HASH_CHANGE_REJECTED", "HOSTED_TOOLCHAIN_CONTROL_WRITABLE_BIND_REJECTED", "HOSTED_TOOLCHAIN_CONTROL_RETAINED_NAMESPACE_REFERENCE_BLOCKS_TEARDOWN"),
        "run_product_leaf_lifecycle_controls": ("HOSTED_PRODUCT_LEAF_CONTROL_EMPTY_INNER_OPT_ACCEPTED", "HOSTED_PRODUCT_LEAF_CONTROL_BLENDER_PREEXISTING_DIRECTORY_REJECTED", "HOSTED_PRODUCT_LEAF_CONTROL_SWOOSHZ_PREEXISTING_DIRECTORY_REJECTED", "HOSTED_PRODUCT_LEAF_CONTROL_FILE_REJECTED", "HOSTED_PRODUCT_LEAF_CONTROL_SYMLINK_REJECTED", "HOSTED_PRODUCT_LEAF_CONTROL_BROKEN_SYMLINK_REJECTED", "HOSTED_PRODUCT_LEAF_CONTROL_SPECIAL_OBJECT_REJECTED", "HOSTED_PRODUCT_LEAF_CONTROL_OTHER_OBJECT_REJECTED", "HOSTED_PRODUCT_LEAF_CONTROL_MOUNTPOINT_REJECTED", "ROUTE_B_PRODUCT_LEAF_CONTROL_DEPLOYED_BLENDER_ACCEPTED", "ROUTE_B_PRODUCT_LEAF_CONTROL_DEPLOYED_SWOOSHZ_ACCEPTED", "ROUTE_B_PRODUCT_LEAF_CONTROL_SYMLINK_DEPLOYMENT_REJECTED", "ROUTE_B_PRODUCT_LEAF_CONTROL_WRONG_DEVICE_REJECTED", "ROUTE_B_PRODUCT_LEAF_CONTROL_WRONG_UID_REJECTED", "ROUTE_B_PRODUCT_LEAF_CONTROL_WRONG_GID_REJECTED", "ROUTE_B_PRODUCT_LEAF_CONTROL_WRONG_MODE_REJECTED", "ROUTE_B_PRODUCT_LEAF_CONTROL_DEFAULT_ACL_REJECTED", "ROUTE_B_PRODUCT_LEAF_CONTROL_NONFIXED_PATH_REJECTED"),
        "validate_fixture_diagnostic_controls": ("run_route_b_opt_controls(expect)", "run_product_leaf_lifecycle_controls(expect)", "run_toolchain_preservation_controls(expect)"),
        "run_fixture": ("validate_toolchain_preservation_events(events, namespace_number, stage_root)", 'namespace_number = ready_event["mountNamespace"]', 'ready_event.get("pid") != owned.pid', 'namespace_identity(owned.pid, "mnt")["number"] != namespace_number', "owned.mount_id = namespace_number", "cleanup_toolchain_stage_root(temp_root, stage_root, namespace_closed=True)", "FIXTURE_NAMESPACE_REFERENCE_REMAINS_AFTER_FAILURE"),
        "validate_outer_opt_snapshot": ("OUTER_OPT_DEVICE_CHANGED", "OUTER_OPT_INODE_CHANGED", "OUTER_OPT_UID_CHANGED", "OUTER_OPT_GID_CHANGED", "OUTER_OPT_MODE_CHANGED", "OUTER_OPT_ACCESS_ACL_CHANGED", "OUTER_OPT_DEFAULT_ACL_CHANGED", "OUTER_OPT_MOUNT_VIEW_CHANGED", "OUTER_OPT_CHILDREN_CHANGED"),
        "validate_inner_opt_mount": ("ROUTE_B_OPT_FILESYSTEM_NOT_DISTINCT", "ROUTE_B_OPT_OWNER_INVALID", "ROUTE_B_OPT_MODE_INVALID", "ROUTE_B_OPT_MOUNT_IDENTITY_INVALID", "ROUTE_B_OPT_MOUNT_STATE_INVALID", "ROUTE_B_OPT_DEFAULT_ACL_INVALID"),
        "validate_inner_opt_child": ("ROUTE_B_OPT_CHILD_IDENTITY_INVALID", "ROUTE_B_OPT_CHILD_MODE_INVALID", "ROUTE_B_OPT_CHILD_DEFAULT_ACL_INVALID"),
        "launch_holder": ("/usr/bin/unshare", "\"--mount\"", "--control-fd", "--result-fd", "--ledger", "--outer-opt-reference", "--toolchain-stage-root", "create_toolchain_stage_root", "serialize_outer_opt_reference(outer_opt)"),
        "holder_entry": ("parse_outer_opt_reference(args.outer_opt_reference)", "args.toolchain_stage_root", "inner_holder("),
        "run_owned_process_regressions": ("child.start_identity + \":mismatch\"", "terminate_owned(child, grace=0.1)"),
        "run_namespace_regressions": ("leaked-holder", "positive-release", "cancel-opt", "cancel-application", "outer_opt=outer_opt", "node=node", "corepack=corepack"),
        "remove_supervisor_state": ("validate_process_ledger(ledger)", "remove_root_owned_state_entry", "NAMESPACE_STATE_CLEANUP_IDENTITY_INVALID"),
    }
    for name, tokens in supervisor_requirements.items():
        source = body(sup, supervisor, name)
        if source is None or any(token not in source for token in tokens):
            return False
    private_toolchain_mount = body(sup, supervisor, "private_opt_mount")
    verify_toolchain_body = body(sup, supervisor, "verify_toolchain")
    if (
        private_toolchain_mount is None
        or '"/opt/blender"' in private_toolchain_mount
        or '"/opt/swooshz"' in private_toolchain_mount
        or "'blender'" in private_toolchain_mount
        or "'swooshz'" in private_toolchain_mount
        or "product_leaf" in private_toolchain_mount.lower()
        or private_toolchain_mount.count("remount,bind,ro,nosuid,nodev") != 2
        or private_toolchain_mount.count("validate_toolchain_bind(") != 2
        or verify_toolchain_body is None
        or verify_toolchain_body.count("validate_toolchain_identity(node_identity, toolchain_identity(node))") != 1
        or verify_toolchain_body.count("validate_toolchain_identity(corepack_identity, toolchain_identity(corepack))") != 1
    ):
        return False
    sudo_matrix = body(sup, supervisor, "run_sudo_matrix")
    if sudo_matrix is None or sudo_matrix.count("os.open(sudoers_path, os.O_WRONLY | os.O_TRUNC | os.O_NOFOLLOW | os.O_CLOEXEC)") != 2:
        return False
    launch = body(sup, supervisor, "launch_owned")
    if launch is None or launch.count("process_start_identity(process.pid)") < 2:
        return False
    inner = body(sup, supervisor, "inner_holder")
    inner_order = (
        '"--make-rprivate"', "private_opt_mount(outer_opt_reference, ledger_path", 'validate_product_leaves_absent(Path("/opt"), inner_opt_identity)', '"deploy", cancel_event=cancel_event)', 'validate_product_leaves_deployed(Path("/opt"), inner_opt_identity)', "run_sudo_matrix(",
        "application_proof(", "active_before_recovery", "if active_before_recovery:", "UNKNOWN_NAMESPACE_PROCESS_REMAINS_BEFORE_RECOVERY",
        '"cleanup", cancel_event=threading.Event())',
    )
    positions = [inner.find(token) for token in inner_order]
    if any(position < 0 for position in positions) or positions != sorted(positions):
        return False
    root = body(sup, supervisor, "root_supervise")
    root_requirements = (
        "workspace != Path(__file__).resolve().parents[3]", "run_namespace_regressions(workspace, temp_root, ledger, outer_ids, outer_opt, args.uid, args.gid, args.node, args.corepack)", "ledger_path=ledger, outer_ids=outer_ids, outer_opt=outer_opt", "holder_events(result_read, 90 * 60, events", "validate_toolchain_preservation_events(events, holder_namespace, stage_root)", 'ready[0].get("pid") != holder.pid', 'namespace_identity(holder.pid, "mnt")', "holder_namespace = ready_namespace", "holder.mount_id = holder_namespace", "cleanup_toolchain_stage_root(temp_root, stage_root, namespace_closed=True)",
        "cancel_event=ROOT_CANCEL_EVENT", "namespace_disappeared(holder_namespace",
        "current_host_ids() != outer_ids or opt_snapshot() != outer_opt", "cleanup_events = [event for event in events if event.get(\"kind\") == \"deploymentCleanup\"]",
        'not cleanup_events[0]["clean"]', "remove_supervisor_state(state, ledger)",
    )
    if root is None or any(token not in root for token in root_requirements) or 'Path(os.environ.get("GITHUB_WORKSPACE"' in root:
        return False
    return True


def hosted_toolcache_product_authority_absent(worker, broker):
    return "/opt/hostedtoolcache" not in worker and "/opt/hostedtoolcache" not in broker


APPLICATION_PROOF_LF_BYTES = 8966
APPLICATION_PROOF_LF_SHA256 = "05c7b06a96fe0c45be71a4e2805b29202250130c9dba4bb852a0ef6032aacd31"
APPLICATION_HELPER_LF_BYTES = 3260
APPLICATION_HELPER_LF_SHA256 = "105085a773513c05abdfbc6b0b6da67b74ad8eb811c91c919cc7a08645bd769e"


def canonical_uniform_lf_source(content):
    paired = content.replace(b"\r\n", b"")
    if b"\r" in paired or (b"\r\n" in content and b"\n" in paired):
        return None
    return content.replace(b"\r\n", b"\n")


def source_identity_matches(content, expected_size, expected_digest):
    return (
        content is not None
        and len(content) == expected_size
        and hashlib.sha256(content).hexdigest() == expected_digest
    )


def valid_hosted_binding(workflow, deployment, supervisor, sudoers, proof_bytes, helper_bytes, worker, broker):
    if not valid_hosted_protected_harness(deployment, supervisor) or not valid_sudoers_template(sudoers):
        return False
    if not hosted_toolcache_product_authority_absent(worker, broker):
        return False
    semantic_call = '--validate-semantic-readback "$carrier/work/input.json" "$carrier/work/validator-readback.json"'
    semantic_tokens = (
        "def validate_workflow_semantic_readback(readback, payload):",
        '"s8-ufbx-readback-v1"', '"semantic synthetic root provenance forbidden"',
        'workflow_semantic_checker_control("VALID_ROOT_AND_PHYSICAL_NODE"',
        '"MISSING_ROOT",',
        '"DUPLICATE_ROOT",',
        '"EXTRA_NODE",',
        '"MALFORMED_ROOT",',
        '"ROOT_SOURCE_OBJECT_ID_PRESENT",',
        '"ROOT_IDENTITY_KEY_PRESENT",',
        "SEMANTIC_READBACK_RESULT=PASS",
    )
    if workflow.count(semantic_call) != 1 or any(token not in supervisor for token in semantic_tokens):
        return False
    if not (
        workflow.index("BEFORE_SEMANTIC_READBACK_IDENTITY_FAILED")
        < workflow.index(semantic_call)
        < workflow.index("CANDIDATE_MARKER_REACHED=YES")
    ):
        return False
    proof_lf = canonical_uniform_lf_source(proof_bytes)
    helper_lf = canonical_uniform_lf_source(helper_bytes)
    if not source_identity_matches(proof_lf, APPLICATION_PROOF_LF_BYTES, APPLICATION_PROOF_LF_SHA256):
        return False
    if not source_identity_matches(helper_lf, APPLICATION_HELPER_LF_BYTES, APPLICATION_HELPER_LF_SHA256):
        return False
    try:
        proof_text, helper_text = proof_lf.decode("utf-8"), helper_lf.decode("utf-8")
    except UnicodeDecodeError:
        return False
    begin, end = "# RUN110_ROUTE_B_SUPERVISOR_BEGIN", "# RUN110_ROUTE_B_SUPERVISOR_END"
    source = 'source "$GITHUB_WORKSPACE/scripts/s8/s8_application_boundary_proof.sh"'
    if workflow.count(begin) != 1 or workflow.count(end) != 1 or workflow.count(source) != 1:
        return False
    if not workflow.index(end) < workflow.index(source):
        return False
    block = workflow[workflow.index(begin):workflow.index(end)]
    required = (
        "broker_deployment_attempted=1", "run_tracked_command /usr/bin/sudo -n -- /usr/bin/python3",
        '"$GITHUB_WORKSPACE/native/s8-sandbox-broker/tests/hosted_deployment_namespace.py"', "--supervise",
        '--workspace "$GITHUB_WORKSPACE"', '--carrier "$carrier"', '--temp-root "$temp_root"',
        '--uid "$runner_uid"', '--gid "$runner_gid"', '--node "$(command -v node)"', '--corepack "$(command -v corepack)"',
        "NAMESPACE_SUPERVISOR_STATE_CLEANUP=PASS", "ROUTE_B_OUTER_OPT_UNCHANGED=YES",
        "ROUTE_B_BROKER_CLEANUP=PASS", "ROUTE_B_PRODUCTION_DEPLOYMENT_ABSENT=YES",
        "HOSTED_POLICY_H=", "HOSTED_CONFIG_Q=", "S8_APP_PRIVATE_ROOT=", "S8_APP_SANDBOX_POLICY_SHA256=",
        "S8_APP_CONFIG_SHA256=", "broker_deployment_attempted=0", "HOSTED_NAMESPACE_HARNESS_HOLD",
    )
    if any(token not in block for token in required) or "--hosted-cleanup" in workflow:
        return False
    binding_markers = (
        "APPLICATION_PRIVATE_ROOT_BINDING=PASS", "APPLICATION_POLICY_H_BINDING=PASS",
        "APPLICATION_CONFIG_Q_BINDING=PASS", "APPLICATION_SANDBOX_BINDING=PASS", "SAME_POLICY_SNAPSHOT_BINDING=PASS",
    )
    if any(workflow.count(marker) != 1 for marker in binding_markers):
        return False
    cleanup_start = workflow.find("          cleanup() {")
    cleanup_end = workflow.find("          trap cleanup EXIT", cleanup_start)
    if cleanup_start < 0 or cleanup_end <= cleanup_start:
        return False
    cleanup = workflow[cleanup_start:cleanup_end]
    if "if (( broker_deployment_attempted == 1 )); then" not in cleanup or "SUPERVISOR_STATE_RESIDUE=YES" not in cleanup or "--hosted-cleanup" in cleanup:
        return False

    policy_start = deployment.find("def hosted_policy(")
    policy_end = deployment.find("\ndef hosted_load_ledger(", policy_start)
    deploy_start = deployment.find("def hosted_deploy(")
    deploy_end = deployment.find("\ndef hosted_cli(", deploy_start)
    if min(policy_start, deploy_start) < 0 or policy_end <= policy_start or deploy_end <= deploy_start:
        return False
    policy, deploy = deployment[policy_start:policy_end], deployment[deploy_start:deploy_end]
    deploy_order = (
        "hosted_create_directory(temp_root, HOSTED_PRIVATE_ROOT, 0o700, record=False)",
        "hosted_verify_private_root_acl(runner_uid, install=True)", "hosted_record_directory(temp_root, HOSTED_PRIVATE_ROOT)",
        "policy_tmp, policy_h, config_q, policy_file_hash = hosted_policy(",
        "hosted_install(temp_root, policy_tmp, HOSTED_POLICY_PATH, 0o600)",
        'hosted_root(str(HOSTED_BROKER), "--recover-v1"',
    )
    positions = [deploy.find(token) for token in deploy_order]
    if any(position < 0 for position in positions) or positions != sorted(positions):
        return False
    policy_order = (
        '"privateWorkRoot": str(HOSTED_PRIVATE_ROOT)', '"sandboxExecutable": str(HOSTED_LAUNCHER)',
        '"privateRootDevice": str(root_state["device"])', '"privateRootInode": str(root_state["inode"])',
        'policy_h = hashlib.sha256(hosted_canonical(policy)).hexdigest()', 'config["sandboxPolicySha256"] = policy_h',
        'config_q = hashlib.sha256(hosted_canonical(config)).hexdigest()', 'del preimage["config"]["sandboxPolicySha256"]',
    )
    positions = [policy.find(token) for token in policy_order]
    if any(position < 0 for position in positions) or positions != sorted(positions) or re.search(r"[\"'][0-9a-f]{64}[\"']", policy + deploy):
        return False
    proof_tokens = (
        "process.env.S8_APP_PRIVATE_ROOT!", "process.env.S8_APP_SANDBOX_POLICY_SHA256!", "process.env.S8_APP_SANDBOX!",
        "runS8BlenderWriter(prepared.bytes, workerConfig)", "runS8NativeValidator(written.artifact, workerConfig)",
        "compareS8UfbxReadback(s6, s7, native.readback)", '"APPLICATION_EXPLICIT_SETENV_COUNT=0"',
        '"FINAL_RUNTIME_ALLOWLIST_PROOF=PASS"', '"BROAD_RUNTIME_BINDS_ABSENT=YES"',
    )
    helper_tokens = (
        "S8_APP_PRIVATE_ROOT", "S8_APP_SANDBOX_POLICY_SHA256", "is required", 'S8_APP_SANDBOX:-/usr/local/libexec/swooshz-s8/s8-sandbox',
        "TARGET_ENV_KEYS=PWD", "PARENT_SECRET_HOSTILE_ENV_LEAKAGE=NO", "PRODUCTION_BOUNDARY_PROOF=PASS",
    )
    if any(token not in proof_text for token in proof_tokens) or any(token not in helper_text for token in helper_tokens):
        return False
    worker_tokens = (
        'const BROKER_LAUNCHER_PATH = "/usr/local/libexec/swooshz-s8/s8-sandbox";', "config.sandboxExecutable !== BROKER_LAUNCHER_PATH",
        'const launcher = assertRegularFile(config.sandboxExecutable ?? "", "sandboxExecutable");',
        'if (launcher !== BROKER_LAUNCHER_PATH) fail("S8_WORKER_SANDBOX_REQUIRED");',
        "spawnSync(/* turbopackIgnore: true */ launcher, [], {", "const configSha256 = s8Sha256(canonicalS8ConfigBytes(config));",
        'Buffer.from(config.sandboxPolicySha256, "hex").copy(header, 28);', 'Buffer.from(configSha256, "hex").copy(header, 60);',
        "expected.policySha256 && header.subarray(152, 184).toString", "validateS8BrokerResponseIdentity(response);", "shell: false",
    )
    broker_tokens = (
        "serialize_policy(&preimage, policy, 0)", "sha256_bytes(preimage.bytes, preimage.length, policy_digest)",
        'strcmp(policy->policy_sha256, policy->config.sandbox_policy_sha256) != 0',
        "serialize_config(&config_bytes, &policy->config, 1)", "sha256_bytes(config_bytes.bytes, config_bytes.length, config_digest)",
        "constant_equal(request->policy_sha256, expected_policy, sizeof(expected_policy))",
        "constant_equal(request->config_sha256, expected_config, sizeof(expected_config))",
    )
    return not any(token not in worker for token in worker_tokens) and not any(token not in broker for token in broker_tokens) and "/usr/bin/bwrap" not in proof_text + helper_text + worker


workflow_source = workflow_path.read_text(encoding="utf-8")
if workflow_path.stat().st_size > 500 * 1024:
    raise SystemExit("GITHUB_WORKFLOW_FILE_EXCEEDS_500_KB")
print("GITHUB_WORKFLOW_FILE_SIZE=PASS")
deployment_source = deployment_path.read_text(encoding="utf-8")
supervisor_source = supervisor_path.read_text(encoding="utf-8")
sudoers_source = sudoers_path.read_text(encoding="ascii")
worker_source = worker_path.read_text(encoding="utf-8")
broker_source = broker_path.read_text(encoding="utf-8")
proof_bytes = proof_path.read_bytes()
helper_bytes = proof_helper_path.read_bytes()


def hosted_binding_accepts(candidate):
    workflow, deployment, supervisor, sudoers, candidate_proof, candidate_helper, worker, broker = candidate
    return valid_hosted_binding(workflow, deployment, supervisor, sudoers, candidate_proof, candidate_helper, worker, broker)


positive_control = (
    workflow_source, deployment_source, supervisor_source, sudoers_source,
    proof_bytes, helper_bytes, worker_source, broker_source,
)
if not hosted_binding_accepts(positive_control):
    raise SystemExit("HOSTED_COMBINED_BROKER_APPLICATION_BINDING_INVALID")
print("APPLICATION_BOUNDARY_HELPER_BYTES=PASS")
print("APPLICATION_WORKER_BROKER_HQ_BINDING=PASS")
print("HOSTED_POLICY_ROOT_BINDING=PASS")
print("HOSTED_PRODUCT_LEAF_LIFECYCLE_STATIC_BINDING=PASS")

def mutate_control(index, value):
    candidate = list(positive_control)
    candidate[index] = value
    return tuple(candidate)


def replace_once(source, old, new):
    if old not in source:
        raise SystemExit("SOURCE_BINDING_NEGATIVE_CONTROL_INPUT_MISSING:" + old[:80])
    return source.replace(old, new, 1)


def mutate_non_eol_byte(content):
    for index, value in enumerate(content):
        if value not in (10, 13):
            return content[:index] + bytes([value ^ 1]) + content[index + 1:]
    raise SystemExit("SOURCE_BINDING_CONTROL_HAS_NO_MUTABLE_CONTENT_BYTE")


def hosted_runtime_identity_checker():
    tree = ast.parse(supervisor_source)
    matches = [
        node for node in tree.body
        if isinstance(node, ast.FunctionDef) and node.name == "application_source_identity_matches"
    ]
    if len(matches) != 1:
        raise SystemExit("HOSTED_RUNTIME_RAW_BYTE_IDENTITY_CHECKER_MISSING")
    namespace = {
        "hashlib": hashlib,
        "APP_PROOF_BYTES": APPLICATION_PROOF_LF_BYTES,
        "APP_PROOF_SHA256": APPLICATION_PROOF_LF_SHA256,
        "APP_HELPER_BYTES": APPLICATION_HELPER_LF_BYTES,
        "APP_HELPER_SHA256": APPLICATION_HELPER_LF_SHA256,
    }
    module = ast.Module(body=matches, type_ignores=[])
    exec(compile(module, "hosted_deployment_namespace.py", "exec"), namespace)
    return namespace["application_source_identity_matches"]


proof_lf = canonical_uniform_lf_source(proof_bytes)
helper_lf = canonical_uniform_lf_source(helper_bytes)
proof_crlf = proof_lf.replace(b"\n", b"\r\n")
helper_crlf = helper_lf.replace(b"\n", b"\r\n")
lf_control = list(positive_control)
lf_control[4], lf_control[5] = proof_lf, helper_lf
if not hosted_binding_accepts(tuple(lf_control)):
    raise SystemExit("CANONICAL_LF_SOURCE_POSITIVE_CONTROL_FAILED")
print("HOSTED_SOURCE_EOL_CONTROL_CANONICAL_LF_PASS=PASS")
if canonical_uniform_lf_source(proof_crlf) != proof_lf or canonical_uniform_lf_source(helper_crlf) != helper_lf:
    raise SystemExit("UNIFORM_CRLF_CANONICALIZATION_CONTROL_FAILED")
crlf_control = list(positive_control)
crlf_control[4], crlf_control[5] = proof_crlf, helper_crlf
if not hosted_binding_accepts(tuple(crlf_control)):
    raise SystemExit("UNIFORM_CRLF_SOURCE_POSITIVE_CONTROL_FAILED")
print("HOSTED_SOURCE_EOL_CONTROL_UNIFORM_CRLF_CANONICALIZES=PASS")
if canonical_uniform_lf_source(proof_lf + b"\r") is not None:
    raise SystemExit("STRAY_CR_SOURCE_CONTROL_ACCEPTED")
print("HOSTED_SOURCE_EOL_CONTROL_STRAY_CR_REJECTED=PASS")
if canonical_uniform_lf_source(proof_lf + b"\r\n") is not None:
    raise SystemExit("MIXED_EOL_SOURCE_CONTROL_ACCEPTED")
print("HOSTED_SOURCE_EOL_CONTROL_MIXED_EOL_REJECTED=PASS")
mutated_proof = mutate_non_eol_byte(proof_crlf)
mutated_canonical = canonical_uniform_lf_source(mutated_proof)
if mutated_canonical is None or source_identity_matches(
    mutated_canonical, APPLICATION_PROOF_LF_BYTES, APPLICATION_PROOF_LF_SHA256
):
    raise SystemExit("CANONICALIZED_CONTENT_MUTATION_CONTROL_ACCEPTED")
mutated_control = list(crlf_control)
mutated_control[4] = mutated_proof
if hosted_binding_accepts(tuple(mutated_control)):
    raise SystemExit("CANONICALIZED_CONTENT_MUTATION_BINDING_ACCEPTED")
print("HOSTED_SOURCE_EOL_CONTROL_CONTENT_MUTATION_REJECTED=PASS")
runtime_identity_matches = hosted_runtime_identity_checker()
if not runtime_identity_matches(proof_lf, helper_lf):
    raise SystemExit("HOSTED_RUNTIME_LF_EXACT_BYTE_CONTROL_FAILED")
if runtime_identity_matches(proof_crlf, helper_crlf):
    raise SystemExit("HOSTED_RUNTIME_RAW_CRLF_CONTROL_ACCEPTED")
print("HOSTED_RUNTIME_RAW_CRLF_EXACT_GATE_REJECTED=PASS")


negative_controls = {
    "NO_SEMANTIC_READBACK_DISPATCH": mutate_control(0, replace_once(workflow_source, "--validate-semantic-readback", "--validate-missing-semantic-readback")),
    "NO_SEMANTIC_REJECTION_CONTROL": mutate_control(2, replace_once(supervisor_source, '        "MISSING_ROOT",', '        "MISSING_ROOT_DISABLED",')),
    "NO_ROUTE_B_SUPERVISOR": mutate_control(0, workflow_source.replace("# RUN110_ROUTE_B_SUPERVISOR_BEGIN", "# RUN110_ROUTE_B_SUPERVISOR_DISABLED", 1)),
    "SHELL_RECOVERY_PATH": mutate_control(0, replace_once(workflow_source, "SUPERVISOR_STATE_RESIDUE=YES", "SUPERVISOR_STATE_RESIDUE=YES --hosted-cleanup")),
    "NO_HOSTED_CLEANUP_WITNESS": mutate_control(0, "\n".join(line for line in workflow_source.splitlines() if "ROUTE_B_BROKER_CLEANUP=" not in line)),
    "PRIVATE_ROOT_PARTIAL_SETUP_ROLLBACK_REMOVED": mutate_control(1, replace_once(deployment_source, "hosted_remove_incomplete_private_root(before)", "pass")),
    "CLEANUP_FIXED_PATH_ABSENCE_CHECK_REMOVED": mutate_control(1, replace_once(deployment_source, "hosted_verify_deployment_absent()", "pass")),
    "DEPLOYMENT_LEAF_FRESHNESS_GATE_REMOVED": mutate_control(1, replace_once(deployment_source, 'raise HostedDeploymentFailure("HOSTED_DEPLOYMENT_PATH_NOT_FRESH")', 'raise HostedDeploymentFailure("HOSTED_DEPLOYMENT_PATH_FRESHNESS_DISABLED")')),
    "DEPLOYMENT_PRODUCT_LEAF_ABSENCE_PATH_REMOVED": mutate_control(1, replace_once(deployment_source, 'Path("/opt/blender"),', 'Path("/opt/blender-disabled"),')),
    "DEPLOYMENT_PRODUCT_RUNTIME_PATH_DRIFT": mutate_control(1, replace_once(deployment_source, 'HOSTED_RUNTIME = Path("/opt/blender")', 'HOSTED_RUNTIME = Path("/opt/blender-disabled")')),
    "DEPLOYMENT_PRODUCT_WRITER_PATH_DRIFT": mutate_control(1, replace_once(deployment_source, 'HOSTED_WRITER_ROOT = Path("/opt/swooshz")', 'HOSTED_WRITER_ROOT = Path("/opt/swooshz-disabled")')),
    "DEPLOYMENT_PRODUCT_LEAF_LEDGER_OWNERSHIP_REMOVED": mutate_control(1, replace_once(deployment_source, 'hosted_create_directory(temp_root, HOSTED_RUNTIME, 0o755)', 'hosted_create_directory(temp_root, HOSTED_RUNTIME, 0o755, record=False)')),
    "DEPLOYMENT_PRODUCT_RUNTIME_CLEANUP_REMOVED": mutate_control(1, replace_once(deployment_source, 'hosted_root("/usr/bin/rm", "-rf", "--", str(target), label="HOSTED_RUNTIME_CLEANUP_FAILED")', "pass")),
    "DEPLOYMENT_PRODUCT_WRITER_CLEANUP_REMOVED": mutate_control(1, replace_once(deployment_source, 'hosted_root("/usr/bin/rmdir", "--", str(target), label="HOSTED_DIRECTORY_CLEANUP_FAILED")', "pass")),
    "SUDOERS_NO_NOPASSWD": mutate_control(3, replace_once(sudoers_source, "NOPASSWD:", "PASSWD:")),
    "SUDOERS_NO_NOSETENV": mutate_control(3, replace_once(sudoers_source, "NOPASSWD: NOSETENV:", "NOPASSWD:")),
    "SUDOERS_NO_STAY_SETUID": mutate_control(3, replace_once(sudoers_source, "stay_setuid,", "")),
    "SUDOERS_BROAD_RECOVERY": mutate_control(3, replace_once(sudoers_source, "^--stdio-v1$", "^(--stdio-v1|--recover-v1)$")),
    "SUDOERS_UNANCHORED_PATH": mutate_control(3, replace_once(sudoers_source, "^/usr/local/libexec/swooshz-s8/s8-sandbox-broker$", "/usr/local/libexec/swooshz-s8/s8-sandbox-broker")),
    "BUILD_AS_ROOT": mutate_control(1, replace_once(deployment_source, 'hosted_run_as_host_user(["/usr/local/bin/cmake", "-S"', 'hosted_root("/usr/local/bin/cmake", "-S"')),
    "DEPLOYMENT_VIA_SUDO": mutate_control(1, replace_once(deployment_source, 'hosted_root(str(HOSTED_BROKER), "--recover-v1"', 'hosted_run(["/usr/bin/sudo", str(HOSTED_BROKER), "--recover-v1"]')),
    "NO_PIDFD_SIGNAL": mutate_control(2, replace_once(supervisor_source, "signal.pidfd_send_signal(self.pidfd, signum)", "os.kill(self.pid, signum)")),
    "NO_START_IDENTITY_CHECK": mutate_control(2, replace_once(supervisor_source, "process_start_identity(process.pid)", "str(process.pid)")),
    "SUDO_MATRIX_RUNNER_OWNED_PATHS": mutate_control(2, replace_once(supervisor_source, 'tempfile.TemporaryDirectory(prefix="s8-sudo-matrix-"', 'tempfile.mkdtemp(prefix="s8-sudo-matrix-"')),
    "SUDOERS_MATRIX_FOLLOWS_SYMLINK": mutate_control(2, replace_once(supervisor_source, "os.open(sudoers_path, os.O_WRONLY | os.O_TRUNC | os.O_NOFOLLOW | os.O_CLOEXEC)", "os.open(sudoers_path, os.O_WRONLY | os.O_TRUNC | os.O_CLOEXEC)")),
    "NO_CANCEL_PROPAGATION": mutate_control(2, replace_once(supervisor_source, '"deploy", cancel_event=cancel_event)', '"deploy", cancel_event=None)')),
    "NO_CHILD_QUIESCENCE_BEFORE_RECOVERY": mutate_control(2, replace_once(supervisor_source, "if active_before_recovery:", "if False:")),
    "NO_APP_UID_ENV_PROOF": mutate_control(2, replace_once(supervisor_source, 'variables != [b"PWD=/work"]', "False")),
    "NO_OUTER_OPT_REVALIDATION": mutate_control(2, supervisor_source.replace("current_host_ids() != outer_ids or opt_snapshot() != outer_opt", "False")),
    "TOOLCHAIN_MINIMAL_SUBTREE_BINDING_REMOVED": mutate_control(2, replace_once(supervisor_source, "os.path.commonpath((str(node_path), str(corepack_path)))", "os.path.dirname(str(node_path))")),
    "PRIVATE_OPT_PRODUCT_LEAF_PRECREATION": mutate_control(2, replace_once(supervisor_source, '    toolchain = verify_toolchain(node, corepack, workspace=workspace, expected={"node": node_identity, "corepack": corepack_identity})', '    toolchain = verify_toolchain(node, corepack, workspace=workspace, expected={"node": node_identity, "corepack": corepack_identity})\n    Path("/opt/blender").mkdir(mode=0o755)')),
    "PRODUCT_LEAF_NAME_BINDING_DRIFT": mutate_control(2, replace_once(supervisor_source, 'ROUTE_B_PRODUCT_LEAF_NAMES = ("blender", "swooshz")', 'ROUTE_B_PRODUCT_LEAF_NAMES = ("blender", "swooshz-extra")')),
    "TOOLCHAIN_READONLY_BIND_REMOVED": mutate_control(2, replace_once(supervisor_source, "remount,bind,ro,nosuid,nodev", "remount,bind,rw,nosuid,nodev")),
    "TOOLCHAIN_EXECUTABLE_IDENTITY_BINDING_REMOVED": mutate_control(2, replace_once(supervisor_source, "validate_toolchain_identity(node_identity, toolchain_identity(node))", "pass")),
    "TOOLCHAIN_NO_BIND_REGRESSION_REMOVED": mutate_control(2, replace_once(supervisor_source, "validate_unpreserved_toolchain_missing(node_missing, corepack_missing)", "pass")),
    "NO_FIXTURE_READY_NAMESPACE_BINDING": mutate_control(2, replace_once(supervisor_source, 'namespace_number = ready_event["mountNamespace"]', "namespace_number = owned.mount_id")),
    "NO_PRODUCTION_READY_NAMESPACE_BINDING": mutate_control(2, replace_once(supervisor_source, "holder_namespace = ready_namespace", "holder_namespace = holder.mount_id")),
    "TOOLCACHE_PRODUCT_AUTHORITY_ADDED_TO_WORKER": mutate_control(6, worker_source + '\nconst productMountAllowlist = ["/opt/hostedtoolcache"];'),
    "TOOLCACHE_PRODUCT_AUTHORITY_ADDED_TO_BROKER": mutate_control(7, broker_source + "\n/* /opt/hostedtoolcache */\n"),
    "NO_RECOVERY_CLEANUP_GATE": mutate_control(2, supervisor_source.replace('not cleanup_events[0]["clean"]', "False")),
    "PINNED_PROOF_BYTES_MISMATCH": mutate_control(4, mutate_non_eol_byte(proof_bytes)),
    "PINNED_HELPER_BYTES_MISMATCH": mutate_control(5, mutate_non_eol_byte(helper_bytes)),
    "WORKER_ALTERNATE_LAUNCHER": mutate_control(6, replace_once(worker_source, "spawnSync(/* turbopackIgnore: true */ launcher, [], {", 'spawnSync("/usr/bin/bwrap", [], {')),
    "WORKER_SHELL_FALLBACK": mutate_control(6, replace_once(worker_source, "shell: false", "shell: true")),
    "BROKER_REQUEST_HQ_MISMATCH": mutate_control(7, replace_once(broker_source, "constant_equal(request->config_sha256, expected_config, sizeof(expected_config))", "constant_equal(request->policy_sha256, expected_config, sizeof(expected_config))")),
}
for label, candidate in negative_controls.items():
    if hosted_binding_accepts(candidate):
        raise SystemExit("HOSTED_COMBINED_BROKER_NEGATIVE_CONTROL_ACCEPTED:" + label)
    print("HOSTED_COMBINED_BROKER_NEGATIVE_CONTROL_" + label + "=PASS")
print("HOSTED_COMBINED_BROKER_APPLICATION_BINDING=PASS")
