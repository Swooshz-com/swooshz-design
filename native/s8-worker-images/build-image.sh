#!/bin/sh
set -eu

usage() {
  printf '%s\n' 'usage: build-image.sh writer|validator|gateway local-tag'
  exit 64
}

[ "$#" -eq 2 ] || usage
kind=$1
tag=$2
case "$kind" in
  writer) dockerfile=native/s8-worker-images/writer/Dockerfile; needs_build=yes ;;
  validator) dockerfile=native/s8-worker-images/validator/Dockerfile; needs_build=yes ;;
  gateway) dockerfile=native/s8-worker-gateway/Dockerfile; needs_build=no ;;
  *) usage ;;
esac

: "${S8_RUNTIME_IMAGE:?set S8_RUNTIME_IMAGE to an approved Node/glibc runtime image reference pinned by digest}"
case "$S8_RUNTIME_IMAGE" in *@sha256:????????????????????????????????????????????????????????????????) ;; *) printf '%s\n' 'S8_RUNTIME_IMAGE_MUST_BE_DIGEST_PINNED' >&2; exit 65 ;; esac
case "$tag" in *[!A-Za-z0-9._:/-]*|'') printf '%s\n' 'IMAGE_TAG_INVALID' >&2; exit 65 ;; esac

if [ "$needs_build" = yes ]; then
  : "${S8_BUILD_IMAGE:?set S8_BUILD_IMAGE to an approved build image reference pinned by digest}"
  case "$S8_BUILD_IMAGE" in *@sha256:????????????????????????????????????????????????????????????????) ;; *) printf '%s\n' 'S8_BUILD_IMAGE_MUST_BE_DIGEST_PINNED' >&2; exit 65 ;; esac
  set -- --build-arg "S8_BUILD_IMAGE=$S8_BUILD_IMAGE" --build-arg "S8_RUNTIME_IMAGE=$S8_RUNTIME_IMAGE"
else
  set -- --build-arg "S8_RUNTIME_IMAGE=$S8_RUNTIME_IMAGE"
fi

docker buildx build \
  --platform linux/amd64 \
  --pull=false \
  --load \
  --file "$dockerfile" \
  "$@" \
  --tag "$tag" \
  .
