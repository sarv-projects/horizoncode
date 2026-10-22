# HorizonCode CI containers

These Docker images package common Linux CI dependencies. Their build and
publication workflows are disabled. The local builder creates host-architecture
images and does not publish or configure a registry.

## Images

- `base`: Ubuntu 24.04 with common build tools and utilities
- `bun-node`: `base` plus Bun and Node.js 24
- `rust`: `bun-node` plus Rust (stable, minimal profile)
- `tauri-linux`: `rust` plus Tauri Linux build dependencies
- `publish`: `bun-node` plus Docker CLI and AUR tooling

## Local build

```sh
TAG=24.04 bun ./packages/containers/script/build.ts
```

Images are tagged under `localhost/horizoncode/build/`. Subsequent Dockerfiles
use that local namespace by default, so the builder does not implicitly pull
the pinned upstream project's CI images. The builder rejects `--push` and
`PUSH=1` before invoking Docker. It builds only for the current host
architecture; multi-architecture publication is unavailable.

## Workflow usage

Publication workflows remain disabled pending the release authorization gates
in [`arch_V1/18-OPERATIONS-RELEASE.md`](../../arch_V1/18-OPERATIONS-RELEASE.md).
Do not reference these local image tags as published workflow artifacts.

## Notes

- Linux containers do not run macOS or Windows jobs.
- A local Docker build may still retrieve base operating-system and
  language-toolchain images or downloads declared in the Dockerfiles. Those
  inputs are not a signed or release-qualified toolchain set.
- Access to a Docker daemon or privileged `docker-in-docker` is not implied by
  this package.
