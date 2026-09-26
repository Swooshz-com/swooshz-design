#!/usr/bin/env python3
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


def hosted_identity(path, *, privileged=False):
    command = ["/usr/bin/stat", "-c", "%d:%i:%u:%g:%a", "--", str(path)]
    value = hosted_sudo(*command, label="HOSTED_IDENTITY_READ_FAILED") if privileged else hosted_run(command, "HOSTED_IDENTITY_READ_FAILED")
    return value.strip()


def hosted_ledger(temp_root):
    return Path(temp_root) / HOSTED_LEDGER_NAME


def hosted_append_ledger(temp_root, row):
    path = hosted_ledger(temp_root)
    with path.open("a", encoding="ascii", newline="\n") as stream:
        stream.write(json.dumps(row, ensure_ascii=True, separators=(",", ":")) + "\n")


def hosted_record_directory(temp_root, path):
    hosted_append_ledger(temp_root, {"kind": "D", "identity": hosted_identity(path, privileged=True), "path": str(path)})


def hosted_record_file(temp_root, path):
    identity = hosted_identity(path, privileged=True)
    digest = hosted_sudo("/usr/bin/sha256sum", "--", str(path), label="HOSTED_FILE_HASH_FAILED").split()[0]
    if not re.fullmatch(r"[0-9a-f]{64}", digest):
        raise HostedDeploymentFailure("HOSTED_FILE_HASH_INVALID")
    hosted_append_ledger(temp_root, {"kind": "F", "identity": identity, "digest": digest, "path": str(path)})


def hosted_create_directory(temp_root, path, mode):
    if path.exists() or path.is_symlink():
        raise HostedDeploymentFailure("HOSTED_DIRECTORY_NOT_FRESH:" + str(path))
    hosted_sudo("/usr/bin/mkdir", "-m", format(mode, "04o"), "--", str(path), label="HOSTED_DIRECTORY_CREATE_FAILED")
    try:
        hosted_record_directory(temp_root, path)
    except Exception:
        hosted_sudo("/usr/bin/rmdir", "--", str(path), label="HOSTED_UNRECORDED_DIRECTORY_CLEANUP_FAILED")
        raise


def hosted_install(temp_root, source, target, mode):
    hosted_sudo("/usr/bin/install", "-o", "root", "-g", "root", "-m", format(mode, "04o"), "--", str(source), str(target), label="HOSTED_FILE_INSTALL_FAILED:" + str(target))
    try:
        hosted_record_file(temp_root, target)
    except Exception:
        hosted_sudo("/usr/bin/rm", "-f", "--", str(target), label="HOSTED_UNRECORDED_FILE_CLEANUP_FAILED")
        raise


def hosted_file_digest(path, mode):
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0))
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or (metadata.st_uid, metadata.st_gid, stat.S_IMODE(metadata.st_mode), metadata.st_nlink) != (0, 0, mode, 1):
            raise HostedDeploymentFailure("HOSTED_DEPLOYED_FILE_IDENTITY_INVALID:" + str(path))
        digest = hashlib.sha256()
        while True:
            block = os.read(descriptor, 1024 * 1024)
            if not block:
                break
            digest.update(block)
        return digest.hexdigest()
    finally:
        os.close(descriptor)


def hosted_policy(temp_root, runner_uid, runner_gid):
    root_stat = HOSTED_PRIVATE_ROOT.lstat()
    if not stat.S_ISDIR(root_stat.st_mode) or (root_stat.st_uid, root_stat.st_gid, stat.S_IMODE(root_stat.st_mode)) != (0, 0, 0o710):
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
        "privateRootDevice": str(root_stat.st_dev),
        "privateRootInode": str(root_stat.st_ino),
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
    if journal.exists() or journal.is_symlink():
        if not HOSTED_BROKER.is_file() or HOSTED_BROKER.is_symlink() or not HOSTED_POLICY_PATH.is_file() or HOSTED_POLICY_PATH.is_symlink():
            raise HostedDeploymentFailure("HOSTED_RECOVERY_INPUTS_INVALID")
        hosted_sudo(str(HOSTED_BROKER), "--recover-v1", label="HOSTED_BROKER_RECOVERY_FAILED")
        journal_meta = journal.lstat()
        if not stat.S_ISDIR(journal_meta.st_mode) or (journal_meta.st_uid, journal_meta.st_gid, stat.S_IMODE(journal_meta.st_mode)) != (0, 0, 0o700):
            raise HostedDeploymentFailure("HOSTED_JOURNAL_IDENTITY_INVALID")
        extra = hosted_sudo("/usr/bin/find", "-P", str(journal), "-mindepth", "1", "-maxdepth", "1", "!", "-name", ".lock", "-print", "-quit", label="HOSTED_JOURNAL_INSPECTION_FAILED").strip()
        if extra:
            raise HostedDeploymentFailure("HOSTED_JOURNAL_UNEXPECTED_CONTENT")
        lock = journal / ".lock"
        if lock.exists() or lock.is_symlink():
            lock_meta = lock.lstat()
            if not stat.S_ISREG(lock_meta.st_mode) or (lock_meta.st_uid, lock_meta.st_gid, stat.S_IMODE(lock_meta.st_mode), lock_meta.st_nlink) != (0, 0, 0o600, 1):
                raise HostedDeploymentFailure("HOSTED_JOURNAL_LOCK_IDENTITY_INVALID")
            hosted_sudo("/usr/bin/rm", "-f", "--", str(lock), label="HOSTED_JOURNAL_LOCK_CLEANUP_FAILED")
        hosted_sudo("/usr/bin/rmdir", "--", str(journal), label="HOSTED_JOURNAL_CLEANUP_FAILED")

    for row in reversed(rows):
        target = Path(row["path"])
        if row["kind"] != "F":
            continue
        if target.is_symlink() or not target.is_file() or hosted_identity(target, privileged=True) != row["identity"]:
            raise HostedDeploymentFailure("HOSTED_FILE_CLEANUP_IDENTITY_INVALID:" + str(target))
        digest = hosted_sudo("/usr/bin/sha256sum", "--", str(target), label="HOSTED_FILE_CLEANUP_HASH_FAILED").split()[0]
        if digest != row["digest"]:
            raise HostedDeploymentFailure("HOSTED_FILE_CLEANUP_HASH_INVALID:" + str(target))
        hosted_sudo("/usr/bin/rm", "-f", "--", str(target), label="HOSTED_FILE_CLEANUP_FAILED")
        if target.exists() or target.is_symlink():
            raise HostedDeploymentFailure("HOSTED_FILE_REMAINS:" + str(target))

    mounts = hosted_run(["/usr/bin/findmnt", "--noheadings", "--raw", "--output", "TARGET"], "HOSTED_MOUNT_INSPECTION_FAILED").splitlines()
    for row in reversed(rows):
        target = Path(row["path"])
        if row["kind"] != "D":
            continue
        if target.is_symlink() or not target.is_dir() or hosted_identity(target, privileged=True) != row["identity"]:
            raise HostedDeploymentFailure("HOSTED_DIRECTORY_CLEANUP_IDENTITY_INVALID:" + str(target))
        if any(mount == str(target) or mount.startswith(str(target).rstrip("/") + "/") for mount in mounts):
            raise HostedDeploymentFailure("HOSTED_NESTED_MOUNT_REFUSED:" + str(target))
        if str(target) == "/opt/blender":
            hosted_sudo("/usr/bin/rm", "-rf", "--", str(target), label="HOSTED_RUNTIME_CLEANUP_FAILED")
        else:
            hosted_sudo("/usr/bin/rmdir", "--", str(target), label="HOSTED_DIRECTORY_CLEANUP_FAILED")
        if target.exists() or target.is_symlink():
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
        if any(path.exists() or path.is_symlink() for path in absent):
            raise HostedDeploymentFailure("HOSTED_DEPLOYMENT_PATH_NOT_FRESH")
        for parent in (Path("/usr/local/libexec"), Path("/var/lib/swooshz")):
            if parent.exists() or parent.is_symlink():
                parent_meta = parent.lstat()
                if not stat.S_ISDIR(parent_meta.st_mode) or parent.is_symlink() or (parent_meta.st_uid, parent_meta.st_gid, stat.S_IMODE(parent_meta.st_mode)) != (0, 0, 0o755):
                    raise HostedDeploymentFailure("HOSTED_DEPLOYMENT_PARENT_IDENTITY_INVALID:" + str(parent))
            else:
                hosted_create_directory(temp_root, parent, 0o755)
        hosted_create_directory(temp_root, Path("/usr/local/libexec/swooshz-s8"), 0o755)
        hosted_create_directory(temp_root, HOSTED_RUNTIME, 0o755)
        hosted_create_directory(temp_root, HOSTED_WRITER_ROOT, 0o755)
        hosted_create_directory(temp_root, HOSTED_PRIVATE_ROOT, 0o710)
        if not Path("/etc/swooshz").exists() and not Path("/etc/swooshz").is_symlink():
            hosted_create_directory(temp_root, Path("/etc/swooshz"), 0o755)

        acl = f"u::rwx,u:{runner_uid}:--x,g::--x,m::--x,o::---"
        hosted_sudo("/usr/bin/setfacl", "--no-mask", "--set", acl, "--", str(HOSTED_PRIVATE_ROOT), label="HOSTED_PRIVATE_ROOT_ACL_CREATE_FAILED")
        acl_text = hosted_sudo("/usr/bin/getfacl", "--numeric", "--omit-header", "--", str(HOSTED_PRIVATE_ROOT), label="HOSTED_PRIVATE_ROOT_ACL_READ_FAILED").strip()
        expected_acl = f"user::rwx\nuser:{runner_uid}:--x\ngroup::--x\nmask::--x\nother::---"
        if acl_text != expected_acl:
            raise HostedDeploymentFailure("HOSTED_PRIVATE_ROOT_ACL_INVALID")

        source_runtime = carrier / "runtime/blender-5.2.2-linux-x64"
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
        hosted_run(["/usr/sbin/visudo", "-c", "-f", str(HOSTED_SUDOERS)], "HOSTED_SUDOERS_VALIDATION_FAILED")

        policy_tmp, policy_h, config_q, policy_file_hash = hosted_policy(temp_root, int(runner_uid), int(runner_gid))
        hosted_install(temp_root, policy_tmp, HOSTED_POLICY_PATH, 0o600)
        if hosted_sudo("/usr/bin/sha256sum", "--", str(HOSTED_POLICY_PATH), label="HOSTED_POLICY_HASH_READ_FAILED").split()[0] != policy_file_hash:
            raise HostedDeploymentFailure("HOSTED_POLICY_INSTALL_HASH_MISMATCH")
        hosted_sudo(str(HOSTED_BROKER), "--recover-v1", label="HOSTED_BROKER_POLICY_ADMISSION_FAILED")
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


def valid_hosted_binding(workflow, deployment, proof_helper, worker, broker, proof_bytes, helper_bytes):
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
        'hosted_run(["/usr/local/bin/cmake", "-S", str(workspace / "native/s8-sandbox-broker")',
        'hosted_run(["/usr/local/bin/cmake", "--build", str(build)',
        'hosted_run(["/usr/local/bin/ctest", "--test-dir", str(build)',
        'broker_build = build / "s8-sandbox-broker"',
        "hosted_create_directory(temp_root, HOSTED_PRIVATE_ROOT, 0o710)",
        'hosted_sudo("/usr/bin/setfacl"',
        "hosted_install(temp_root, broker_build, HOSTED_BROKER, 0o755)",
        'hosted_install(temp_root, workspace / "native/s8-sandbox-broker/deploy/s8-sandbox", HOSTED_LAUNCHER, 0o755)',
        'hosted_install(temp_root, workspace / "native/s8-sandbox-broker/deploy/swooshz-s8-broker-recover.service"',
        'hosted_install(temp_root, workspace / "native/s8-sandbox-broker/deploy/swooshz-s8-broker-recover.timer"',
        "policy_tmp, policy_h, config_q, policy_file_hash = hosted_policy(",
        "hosted_install(temp_root, policy_tmp, HOSTED_POLICY_PATH, 0o600)",
        'hosted_sudo(str(HOSTED_BROKER), "--recover-v1"',
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
        "root_stat = HOSTED_PRIVATE_ROOT.lstat()",
        '"privateWorkRoot": str(HOSTED_PRIVATE_ROOT)',
        '"sandboxExecutable": str(HOSTED_LAUNCHER)',
        '"blenderExecutableSha256": hosted_file_digest(HOSTED_RUNTIME / "blender", 0o755)',
        '"privateRootDevice": str(root_stat.st_dev)',
        '"privateRootInode": str(root_stat.st_ino)',
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
print("APPLICATION_BOUNDARY_HELPER_BYTES=PASS")
print("APPLICATION_WORKER_BROKER_HQ_BINDING=PASS")
print("HOSTED_POLICY_ROOT_BINDING=PASS")

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
}
for label, candidate in negative_controls.items():
    if hosted_binding_accepts(candidate):
        raise SystemExit("HOSTED_COMBINED_BROKER_NEGATIVE_CONTROL_ACCEPTED:" + label)
    print("HOSTED_COMBINED_BROKER_NEGATIVE_CONTROL_" + label + "=PASS")
print("HOSTED_COMBINED_BROKER_APPLICATION_BINDING=PASS")