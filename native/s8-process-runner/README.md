# S8 native process runner

`s8-process-runner` is the Linux-only process boundary for the S8 Blender
writer and ufbx validator. It applies address-space, file-size, CPU-time,
stdout/stderr, parent-death, and child-process limits before `execvp`, kills
the complete process group on timeout or output overflow, and forwards only
bounded output to its caller.

The TypeScript worker requires this executable. Node `spawnSync` options are
only transport protection around the runner and are not treated as the
production resource-enforcement mechanism.
