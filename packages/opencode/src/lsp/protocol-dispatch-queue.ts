/** Serializes protocol writes and fences later writes after an uncertain outcome. */
export function makeProtocolDispatchQueue() {
  let tail: Promise<void> = Promise.resolve()
  let stopped = false
  let failure: unknown

  return {
    run<T>(dispatch: () => Promise<T>): Promise<T> {
      const result = tail.then(() => {
        if (stopped) throw failure
        return dispatch()
      })
      tail = result.then(
        () => undefined,
        (error) => {
          if (!stopped) {
            stopped = true
            failure = error
          }
        },
      )
      return result
    },
  }
}
