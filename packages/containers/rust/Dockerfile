ARG REGISTRY=localhost/horizoncode
ARG IMAGE_TAG=24.04
FROM ${REGISTRY}/build/bun-node:${IMAGE_TAG}

ARG RUST_TOOLCHAIN=stable

ENV CARGO_HOME=/opt/cargo
ENV RUSTUP_HOME=/opt/rustup
ENV PATH=/opt/cargo/bin:/opt/bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

RUN set -euo pipefail; \
  curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain "${RUST_TOOLCHAIN}"; \
  rustc --version; \
  cargo --version
