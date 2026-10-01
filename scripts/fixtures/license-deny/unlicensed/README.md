# Missing-license negative control

This standalone, non-member Cargo package depends on a local synthetic package
without a `license` or `license-file` declaration. It proves that the repository's
policy does not silently accept unlicensed dependencies. It contains no third-party
code, is never built or distributed, and has its own lockfile.
