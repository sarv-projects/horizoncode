ARG REGISTRY=localhost/horizoncode
ARG IMAGE_TAG=24.04
FROM ${REGISTRY}/build/bun-node:${IMAGE_TAG}

ARG DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    docker.io \
    pacman-package-manager \
  && rm -rf /var/lib/apt/lists/*
