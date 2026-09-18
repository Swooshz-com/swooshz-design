# S8 Blender FBX writer

`writer.py` is the GPL-compatible Blender-side serializer for
`swooshz-fbx-writer-input-v1`. It is deliberately isolated from proprietary
Swooshz code. The script accepts only explicit vertices, triangles, corner
normals, transforms, hierarchy, preview-material values, and bounded source
stamps. It does not make geometry, material, source-admission, publication, or
business decisions.

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
