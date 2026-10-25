import { createMemo, createSignal, onCleanup, Show } from "solid-js"
import { useTheme } from "../context/theme"
import type { TuiArtifactRendererV1 } from "../util/artifact-render"
import { inspectCodeDisplayBounds, DEFAULT_CODE_DISPLAY_POLICY } from "../util/code-display"

/**
 * Renders one assistant text part through the artifact renderer boundary.
 *
 * The renderer itself is owned by the session route (one bounded worker per
 * mounted session) and disposed there; this component only subscribes for
 * isolated-frame updates and unsubscribes on unmount. Text arrives synchronously
 * with the inert original source; a worker frame is adopted on a later render,
 * and worker absence or failure keeps the source fallback with a truthful
 * diagnostic instead of parsing SVG on the caller thread.
 */
export function ArtifactMarkdown(props: {
  source: string
  complete: boolean
  renderer: TuiArtifactRendererV1
  conceal?: boolean
}) {
  const { theme, syntax } = useTheme()
  const [revision, setRevision] = createSignal(0)
  const unsubscribe = props.renderer.subscribe(() => setRevision((value) => value + 1))
  onCleanup(unsubscribe)

  const rendered = createMemo(() => {
    revision()
    return props.renderer.render(props.source, props.complete)
  })
  const derivedPreview = createMemo(() => {
    const source = props.source
    const hasDerivedContent =
      /```(?:svg|mermaid)\b/i.test(source) ||
      /^\|[^\n]+\|\s*\n\|\s*:?-{3,}/m.test(source)
    if (!hasDerivedContent) return
    return rendered().fidelity
  })
  // §31.23: long settled/fenced content is concealed by default; the canonical
  // part/artifact remains the source for expansion and review.
  const autoConceal = createMemo(() => {
    const bounds = inspectCodeDisplayBounds(props.source, {
      maxLines: DEFAULT_CODE_DISPLAY_POLICY.concealAfterLines,
      maxBytes: DEFAULT_CODE_DISPLAY_POLICY.lazyHighlightMaxBytes,
    })
    return bounds.exceedsLineLimit || bounds.exceedsByteLimit
  })

  return (
    <box flexDirection="column">
      <Show when={derivedPreview()}>
        {(fidelity) => (
          <text fg={theme.textMuted}>{`Derived artifact preview: ${fidelity()}`}</text>
        )}
      </Show>
      <markdown
        syntaxStyle={syntax()}
        streaming={!props.complete}
        internalBlockMode="top-level"
        content={rendered().content}
        tableOptions={{ style: "grid" }}
        conceal={props.conceal ?? autoConceal()}
        fg={theme.markdownText}
        bg={theme.background}
      />
    </box>
  )
}
