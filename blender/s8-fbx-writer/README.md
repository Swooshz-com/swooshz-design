# S8 Blender FBX writer

`writer.py` is the GPL-compatible Blender-side serializer for
`swooshz-fbx-writer-input-v1`. It is deliberately isolated from proprietary
Swooshz code. The script accepts only explicit vertices, triangles, corner
normals, transforms, hierarchy, preview-material values, and bounded source
stamps. It does not make geometry, material, source-admission, publication, or
business decisions.

The exporter module is the Blender 5.2.2 FBX exporter blob pinned in
`src/lib/s8-fbx-profile.ts`, preserved in `export_fbx_bin.py` with the narrow
`s8-b3-source-rigid-exporter-v1` transform-property patch. The immutable
`patch-manifest.json` binds the upstream Git blob identities and private patch
SHA-256. The writer calls this module directly with the source-rigid table; it
does not invoke `bpy.ops.export_scene.fbx` or use Blender transform
decomposition as an admission or serialization fallback.

The application worker runs the exact official Blender 5.2.2 LTS Linux x64
portable build with `--background --factory-startup --disable-autoexec
--offline-mode --python-exit-code 50` through the pinned native process runner
and bubblewrap. Writer and validator launches use the same production boundary:
UID/GID 65534, all capabilities dropped, user/network/PID/IPC/UTS namespaces,
disabled nested user namespaces, parent-death and session controls, a private
working directory, private `/tmp`, and no inherited credentials. Bubblewrap
clears the environment and uses only its intrinsic `PWD` key after changing to
`/work`; the application sets no environment variables. The only additional
system file bind is read-only `/etc/passwd`; pinned runtime files are mounted
read-only and one-to-one. No network access is available in the sandbox.

Only `artifact.fbx` and `writer-receipt.json` may leave the process boundary,
and neither is publishable until the separate pinned ufbx validator compares
the artifact with independently derived S6 semantics.

Internal service execution is the reviewed MVP packaging posture. Distribution
of Blender, its exporter, this script, or an image containing them outside the
organisation requires a fresh licence review and delivery of all applicable
licence/source notices.
