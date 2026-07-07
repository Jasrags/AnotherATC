/**
 * True when a keydown originates from (or a text field currently holds focus on) an
 * editable element — a keyboard shortcut handler should bail so it doesn't hijack typing.
 * Duck-typed on tagName/isContentEditable so it works for real DOM nodes and is testable
 * without a DOM. Pass the event target; falls back to document.activeElement.
 */
type EditableLike = { tagName?: string; isContentEditable?: boolean } | null | undefined

function editable(el: EditableLike): boolean {
  if (!el) return false
  const tag = el.tagName?.toUpperCase()
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return el.isContentEditable === true
}

export function isTypingTarget(target: EventTarget | null | undefined): boolean {
  if (editable(target as EditableLike)) return true
  // Some keydowns (e.g. from window) have a non-element target; check the focused element.
  const active = typeof document !== 'undefined' ? document.activeElement : null
  return editable(active as EditableLike)
}
