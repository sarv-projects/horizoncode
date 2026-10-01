# License policy negative control

This standalone, non-member Cargo package depends on a local synthetic package
declaring `GPL-3.0-only`, so CI proves the checked-in policy rejects a disallowed
dependency rather than merely inspecting the fixture root package. A separate
[`unlicensed` fixture](unlicensed/README.md) proves that missing-license packages
are rejected too. The fixtures contain no third-party code, are not HorizonCode
workspace members, and are never built or distributed.
