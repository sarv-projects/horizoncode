ARG REGISTRY=localhost/horizoncode
ARG IMAGE_TAG=24.04
FROM ${REGISTRY}/build/rust:${IMAGE_TAG}

ARG DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    libappindicator3-dev \
    libwebkit2gtk-4.1-dev \
    librsvg2-dev \
    patchelf \
  && rm -rf /var/lib/apt/lists/*
