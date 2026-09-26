# Sourced by the S8 hosted workflow after the deployment carrier and broker are admitted.
admit_work_for_use || fail_hold "WORK_BEFORE_APPLICATION_BOUNDARY_PROOF_FAILED"
app_proof="$temp_root/s8-application-boundary-proof.mts"
/usr/bin/install -m 0600 -- "$GITHUB_WORKSPACE/scripts/s8/s8_application_boundary_proof.mts" "$app_proof"
export S8_APP_CARRIER="$carrier"
export S8_APP_WORK="$carrier/work"
export S8_APP_SANDBOX="${S8_APP_SANDBOX:-/usr/local/libexec/swooshz-s8/s8-sandbox}"
export S8_APP_PRIVATE_ROOT="${S8_APP_PRIVATE_ROOT:?S8_APP_PRIVATE_ROOT is required}"
export S8_APP_SANDBOX_POLICY_SHA256="${S8_APP_SANDBOX_POLICY_SHA256:?S8_APP_SANDBOX_POLICY_SHA256 is required}"
COREPACK_ENABLE_AUTO_PIN=0 corepack pnpm@12.6.0 exec tsx "$app_proof" >"$temp_root/application-proof.stdout" 2>"$temp_root/application-proof.stderr" &
app_proof_pid=$!
set +e
/usr/bin/sudo -n /usr/bin/python3 - "$app_proof_pid" "$temp_root/application-target-env.status" <<'PY'
import os
import pathlib
import sys
import time

application_pid = int(sys.argv[1])
status_path = pathlib.Path(sys.argv[2])
observed = set()
error = False
while True:
    try:
        process_state = (pathlib.Path("/proc") / str(application_pid) / "stat").read_text(encoding="ascii").rsplit(")", 1)[1].strip().split()[0]
        if process_state == "Z":
            break
    except FileNotFoundError:
        break
    try:
        os.kill(application_pid, 0)
    except ProcessLookupError:
        break
    for entry in pathlib.Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            command = (entry / "cmdline").read_bytes()
            kind = "writer" if b"/runtime/blender-root/blender\0" in command else "validator" if b"/runtime/validator\0" in command else None
            if kind is None:
                continue
            variables = [item for item in (entry / "environ").read_bytes().split(b"\0") if item]
            keys = {item.split(b"=", 1)[0] for item in variables}
            if len(variables) != 1 or keys != {b"PWD"} or b"PWD=/work" not in variables:
                error = True
            observed.add(kind)
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            continue
    time.sleep(0.003)
status_path.write_text("PASS\n" if not error and observed == {"writer", "validator"} else "FAIL\n", encoding="ascii")
if error or observed != {"writer", "validator"}:
    raise SystemExit(1)
PY
target_env_status=$?
wait "$app_proof_pid"
app_proof_status=$?
set -e
if (( app_proof_status == 126 || app_proof_status == 127 )); then
  printf 'FAILURE_CLASS=HOSTED_TOOLCHAIN_HOLD\nTOOLCHAIN_STAGE=APPLICATION_PROOF_LAUNCH\nAPPLICATION_PROOF_LAUNCH_STATUS=%s\n' "$app_proof_status" >&2
fi
if (( app_proof_status != 0 )); then
  /usr/bin/cat -- "$temp_root/application-proof.stderr" >&2
  exit "$app_proof_status"
fi
(( target_env_status == 0 )) || fail_hold "APPLICATION_TARGET_ENVIRONMENT_PROOF_FAILED"
/usr/bin/grep -Fx 'PASS' "$temp_root/application-target-env.status" >/dev/null || fail_hold "APPLICATION_TARGET_ENVIRONMENT_STATUS_INVALID"
/usr/bin/cat -- "$temp_root/application-proof.stdout"
printf 'TARGET_ENV_KEYS=PWD\nPARENT_SECRET_HOSTILE_ENV_LEAKAGE=NO\nPRODUCTION_BOUNDARY_PROOF=PASS\n'
