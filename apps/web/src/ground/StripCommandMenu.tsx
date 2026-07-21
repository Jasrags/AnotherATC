import { useEffect, useId, useRef, useState } from 'react'
import type { GroundController, StripItem } from './controller'
import { commandsFor } from './commands'
import { isTypingTarget } from './keyboard'

/** Numbered, state-dependent command menu for the selected flight strip. */
export function StripCommandMenu({
  controller,
  item,
  aircraft,
}: {
  controller: GroundController
  item: StripItem
  aircraft: StripItem[]
}) {
  const [openSub, setOpenSub] = useState<number | null>(null)
  const commands = commandsFor(controller, item, aircraft)
  const menuId = useId()
  const subId = (i: number): string => `${menuId}-sub-${i}`

  const stop = (e: React.MouseEvent) => e.stopPropagation()
  const activate = (i: number): void => {
    const action = commands[i]?.action
    if (!action) return
    if (action.kind === 'run') {
      action.run()
      setOpenSub(null)
    } else if (action.kind === 'submenu') {
      setOpenSub((s) => (s === i ? null : i))
    }
  }

  // Number-key shortcuts (1–9, 0) for the selected aircraft. Registered once while the
  // menu is mounted (i.e. while this strip is selected and not route-building); reads the
  // current commands via a ref so it never needs to re-subscribe.
  const commandsRef = useRef(commands)
  // Keep the ref current after each render (not during — see the project hooks rule);
  // event handlers fire after effects, so the listener always sees the latest commands.
  useEffect(() => {
    commandsRef.current = commands
  })
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (isTypingTarget(e.target)) return // leave keys to a focused text field
      const cmds = commandsRef.current
      const n = e.key === '0' ? 10 : /^[1-9]$/.test(e.key) ? Number(e.key) : 0
      if (n < 1 || n > cmds.length) return
      const action = cmds[n - 1]?.action
      if (!action || action.kind === 'soon') return
      e.preventDefault()
      if (action.kind === 'run') {
        action.run()
        setOpenSub(null)
      } else {
        setOpenSub((s) => (s === n - 1 ? null : n - 1))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // A phase with no controller actions (e.g. an automatic pushback) shows no menu at all,
  // rather than an empty box. Placed after the hooks so their order stays unconditional.
  if (commands.length === 0) return null

  return (
    <div className="cmd-menu" onClick={stop}>
      {commands.map((c, i) => {
        const num = i + 1 >= 10 ? 0 : i + 1
        const disabled = c.action.kind === 'soon'
        const isSub = c.action.kind === 'submenu'
        return (
          <div key={c.label}>
            <button
              type="button"
              className={`cmd-item${disabled ? ' cmd-disabled' : ''}${openSub === i ? ' cmd-open' : ''}`}
              disabled={disabled}
              aria-haspopup={isSub ? 'menu' : undefined}
              aria-expanded={isSub ? openSub === i : undefined}
              aria-controls={isSub && openSub === i ? subId(i) : undefined}
              onClick={(e) => {
                stop(e)
                activate(i)
              }}
            >
              <span className="cmd-num">{num}</span>
              <span className="cmd-label">{c.label}</span>
              {isSub && <span className="cmd-caret">›</span>}
              {disabled && <span className="cmd-soon">soon</span>}
            </button>
            {c.action.kind === 'submenu' && openSub === i && (
              <div className="cmd-sub" id={subId(i)} role="menu">
                {c.action.items.map((leaf) => (
                  <button
                    type="button"
                    key={leaf.label}
                    role="menuitem"
                    className="cmd-item cmd-sub-item"
                    onClick={(e) => {
                      stop(e)
                      leaf.run()
                      setOpenSub(null)
                    }}
                  >
                    {leaf.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
