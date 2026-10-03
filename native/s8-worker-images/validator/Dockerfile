# syntax=docker/dockerfile:1.7
ARG S8_BUILD_IMAGE
ARG S8_RUNTIME_IMAGE
FROM ${S8_BUILD_IMAGE} AS build
WORKDIR /src
COPY native/s8-process-runner/ /src/native/s8-process-runner/
COPY native/s8-fbx-validator/ /src/native/s8-fbx-validator/
RUN cmake -S native/s8-process-runner -B /tmp/build-runner -DCMAKE_BUILD_TYPE=Release \
    && cmake --build /tmp/build-runner --target s8-process-runner --parallel 2 \
    && cmake -S native/s8-fbx-validator -B /tmp/build-validator -DCMAKE_BUILD_TYPE=Release \
    && cmake --build /tmp/build-validator --target s8-fbx-validator --parallel 2 \
    && install -D -m 0755 /tmp/build-runner/s8-process-runner /out/s8-process-runner \
    && install -D -m 0755 /tmp/build-validator/s8-fbx-validator /out/s8-fbx-validator

FROM ${S8_RUNTIME_IMAGE} AS runtime
RUN mkdir -p /opt/s8 /work /usr/share/doc/swooshz-s8 \
    && chmod 0555 /opt/s8 /work
COPY --from=build /out/s8-process-runner /usr/local/bin/s8-process-runner
COPY --from=build /out/s8-fbx-validator /usr/local/bin/s8-fbx-validator
COPY native/s8-fbx-validator/LICENSE /usr/share/doc/swooshz-s8/ufbx-LICENSE
COPY native/s8-worker-common/worker-entrypoint.mjs /opt/s8/worker-entrypoint.mjs
COPY native/s8-worker-common/protocol.mjs /opt/s8/protocol.mjs
ENV PATH=/usr/local/bin:/usr/bin:/bin
USER 65532:65532
WORKDIR /work
ENTRYPOINT ["node", "/opt/s8/worker-entrypoint.mjs"]
