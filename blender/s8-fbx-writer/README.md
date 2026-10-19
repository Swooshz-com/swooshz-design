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

The supervisor must run the exact official Blender 5.2.2 LTS Linux x64
portable build with `--background --factory-startup --disable-autoexec
--offline-mode --python-exit-code 50`, a private working directory, no inherited
credentials, OS-enforced network denial, and fixed input/output basenames.

Only `artifact.fbx` and `writer-receipt.json` may leave the process boundary,
and neither is publishable until the separate pinned ufbx validator compares
the artifact with independently derived S6 semantics.

Internal service execution is the reviewed MVP packaging posture. Distribution
of Blender, its exporter, this script, or an image containing them outside the
organisation requires a fresh licence review and delivery of all applicable
licence/source notices.
