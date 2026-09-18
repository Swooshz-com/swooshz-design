# Independent S8 FBX validator

This C99 process vendors ufbx v0.23.0 at commit
`fcc5d6ba444cfd3eb80677dba5e37e493941abe5`, tree
`f99a3b0e775053f91ea16494d7b7be5102812d32`, under its MIT licence.

The process loads an artifact from memory with strict parsing, quirks and
external files disabled, bounded allocators, and no generated normals. It fails
on parser warnings/repairs, unsupported scene features, non-binary/non-7400 FBX,
wrong units/axes, hidden transform channels, missing normals, non-triangle
faces, or forbidden media/animation/camera/light/deformer content. Its JSON
readback contains the parsed hierarchy, local/world matrices, control points,
oriented triangles, and effective indexed corner normals. Proprietary
`s8-fbx-semantic.ts` independently derives the expected values from live S6
truth and compares them; neither the writer receipt nor writer memory is an
oracle.

Build with:

```text
cmake -S native/s8-fbx-validator -B build/s8-fbx-validator -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build build/s8-fbx-validator
ctest --test-dir build/s8-fbx-validator --output-on-failure
```
