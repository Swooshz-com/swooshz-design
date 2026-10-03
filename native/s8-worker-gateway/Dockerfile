# syntax=docker/dockerfile:1.7
ARG S8_RUNTIME_IMAGE
FROM ${S8_RUNTIME_IMAGE}
WORKDIR /opt/s8
COPY native/s8-worker-common/protocol.mjs /opt/s8/protocol.mjs
COPY native/s8-worker-common/admission.mjs /opt/s8/admission.mjs
COPY native/s8-worker-common/resource-policy.mjs /opt/s8/resource-policy.mjs
COPY native/s8-worker-gateway/gateway.mjs /opt/s8/gateway.mjs
ENV PATH=/usr/local/bin:/usr/bin:/bin
USER 65532:65532
ENTRYPOINT ["node", "/opt/s8/gateway.mjs"]
