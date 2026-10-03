# syntax=docker/dockerfile:1.7
ARG S8_BUILD_IMAGE
ARG S8_RUNTIME_IMAGE
FROM ${S8_BUILD_IMAGE} AS build
WORKDIR /src
COPY native/s8-process-runner/ /src/native/s8-process-runner/
RUN cmake -S native/s8-process-runner -B /tmp/build-runner -DCMAKE_BUILD_TYPE=Release \
    && cmake --build /tmp/build-runner --target s8-process-runner --parallel 2 \
    && install -D -m 0755 /tmp/build-runner/s8-process-runner /out/s8-process-runner

FROM ${S8_BUILD_IMAGE} AS blender
ADD --checksum=sha256:84098912789dc450e95697c4184fb8a90acbe5111c2ba4aede3fecb57806a168 \
  https://download.blender.org/release/Blender5.2/blender-5.2.2-linux-x64.tar.xz /tmp/blender.tar.xz
RUN mkdir -p /opt/blender \
    && tar -xJf /tmp/blender.tar.xz --strip-components=1 -C /opt/blender \
    && rm -f /tmp/blender.tar.xz

FROM ${S8_RUNTIME_IMAGE} AS runtime
RUN mkdir -p /opt/s8 /opt/blender /work /usr/share/doc/swooshz-s8 \
    && chmod 0555 /opt/s8 /opt/blender /work
COPY --from=build /out/s8-process-runner /usr/local/bin/s8-process-runner
COPY --from=blender /opt/blender/ /opt/blender/
COPY blender/s8-fbx-writer/writer.py /opt/s8/writer.py
COPY blender/s8-fbx-writer/export_fbx_bin.py /opt/s8/export_fbx_bin.py
COPY blender/s8-fbx-writer/patch-manifest.json /opt/s8/patch-manifest.json
COPY blender/s8-fbx-writer/LICENSE /usr/share/doc/swooshz-s8/LICENSE
COPY blender/s8-fbx-writer/NOTICE.md /usr/share/doc/swooshz-s8/NOTICE.md
COPY native/s8-worker-common/worker-entrypoint.mjs /opt/s8/worker-entrypoint.mjs
COPY native/s8-worker-common/protocol.mjs /opt/s8/protocol.mjs
ENV PATH=/usr/local/bin:/usr/bin:/bin
USER 65532:65532
WORKDIR /work
ENTRYPOINT ["node", "/opt/s8/worker-entrypoint.mjs"]
