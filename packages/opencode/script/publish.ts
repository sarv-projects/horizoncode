/**
 * HorizonCode release boundary.
 *
 * The pinned OpenCode publisher remains available only inside `opencode/` for
 * provenance. This first-party overlay intentionally does not build, upload,
 * sign, publish, push, or mutate a package registry. Replace it only after the
 * legal, signing, product-target, and exact-candidate release gates are approved.
 */
console.error("HorizonCode publication is disabled pending release authorization.")
process.exitCode = 1
