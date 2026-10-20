process.env.HORIZONCODE_UNBUNDLED_PROVIDER_IMPORTED = "1"

export function create() {
  return {
    languageModel() {
      throw new Error("unbundled provider fixture must not be invoked")
    },
  }
}
