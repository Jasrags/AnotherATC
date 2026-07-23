import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { TRAFFIC_LEVELS, type GroundController } from './controller'
import { saveTrafficRate } from './prefs'
import { centerOn, clearanceRangeNm, fitPoints, fitView, pan, reframe, toWorld, zoomAt, type View } from './view'
import {
  drawAircraft,
  drawApproachCourse,
  drawAreaLabels,
  drawGates,
  drawGraphOverlay,
  drawHotspots,
  drawLabels,
  drawOffscreenTraffic,
  drawProbe,
  drawRouteDraft,
  drawRouteHover,
  drawRunwayExits,
  drawRunwayMarkings,
  runwayMarkingsVisible,
  drawSelection,
  drawSpawnPreview,
  drawStandHighlight,
  drawSurface,
  nearestTaxiwayRef,
  prepareSurface,
  distanceToNetworkNm,
} from './render'
import { COLORS, DIMS } from './palette'
import { isTypingTarget } from './keyboard'
import { FIXED_DT, tick } from './simClock'
import { awaitingAlert, conflictAlert, incursionAlert } from './alerts'
import type { GroundAircraft } from '@anotheratc/sim'

/** Click must land within this many px of a target to select it. */
const HIT_PX = 14
/** Click within this many px of a taxiway snaps to it (generous — the hover preview
 *  shows exactly which taxiway will be picked, so a wide radius is safe). */
const TAXI_HIT_PX = 26
/** Pointer movement beyond this (px) counts as a pan, not a click. */
const DRAG_PX = 4

/** Set an element's text only when it changed — avoids re-announcing aria-live regions. */
function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text
}

export function GroundScope({ controller }: { controller: GroundController }) {
  // Everything field-specific comes off the airport bundle, so this component is the same code
  // whichever airport it is pointed at.
  const airport = controller.airport
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const statusRef = useRef<HTMLDivElement>(null)
  const hintRef = useRef<HTMLDivElement>(null)
  const alertRef = useRef<HTMLDivElement>(null)
  const alertSrRef = useRef<HTMLDivElement>(null)
  const gateAlertRef = useRef<HTMLDivElement>(null)
  const awaitingRef = useRef<HTMLDivElement>(null)
  const awaitingSrRef = useRef<HTMLDivElement>(null)
  const incursionRef = useRef<HTMLButtonElement>(null)
  const incursionMarkRef = useRef<HTMLSpanElement>(null)
  const incursionTextRef = useRef<HTMLSpanElement>(null)
  const incursionSrRef = useRef<HTMLDivElement>(null)
  // The aircraft the banner would take you to, kept on a ref because the banner is written
  // from the render loop rather than re-rendered by React.
  const incursionFocusRef = useRef<string | null>(null)
  const devRef = useRef<HTMLDivElement>(null)

  // Admin routing-graph overlay. The render loop reads a ref (no effect re-run); the state
  // just drives the button's pressed styling. Toggled by the button or the "g" key.
  const [showGraph, setShowGraph] = useState(false)
  const showGraphRef = useRef(false)
  const toggleGraph = () => {
    showGraphRef.current = !showGraphRef.current
    setShowGraph(showGraphRef.current)
  }

  // A pending "frame everything" request. The view lives inside the render effect, so the
  // button/key just raises a flag the next frame consumes.
  const refitRef = useRef(false)
  const requestRefit = () => {
    refitRef.current = true
  }

  // Airport configuration. KSAN is single-runway, so this moves the arrival final *and* the
  // departure end together — you cannot land one way and depart the other. Read off the
  // published snapshot, not mirrored in local state: the sim can refuse a change, and anything
  // else that switches the runway has to be reflected here too.
  const activeRunway = useSyncExternalStore(controller.subscribe, controller.getSnapshot).activeRunway
  const toggleRunway = () => {
    // Cycle the field's configurations, whatever they are — two on a single-runway airport.
    const idents = controller.runwayIdents()
    const next = idents[(idents.indexOf(activeRunway) + 1) % idents.length]
    if (next) controller.setRunway(next)
  }

  // Time control. The ref drives the fixed-timestep loop; the state drives the buttons. 0 is
  // paused — the sim simply stops accumulating, so everything else (pan, zoom, select, and
  // issuing clearances) keeps working while it is stopped.
  const SPEEDS = [1, 2, 4] as const
  const [speed, setSpeed] = useState<number>(1)
  const speedRef = useRef(1)
  const applySpeed = (n: number) => {
    speedRef.current = n
    setSpeed(n)
  }
  const togglePause = () => applySpeed(speedRef.current === 0 ? 1 : 0)

  // Traffic level: how much new traffic the field generates. Separate from the time control —
  // one changes how fast the game runs, the other how busy it is — and remembered across
  // reloads, because working one mechanic at a time shouldn't mean re-setting it every load.
  const [trafficRate, setTrafficRateState] = useState<number>(() => controller.trafficRate())
  const applyTrafficRate = (rate: number) => {
    controller.setTrafficRate(rate)
    saveTrafficRate(rate)
    setTrafficRateState(rate)
  }

  // Dev sandbox: which surface-click tool is armed. Ref drives the click/render loop;
  // state drives the toolbar's pressed styling.
  type DevTool = 'none' | 'spawn' | 'delete' | 'probe'
  const [devTool, setDevTool] = useState<DevTool>('none')
  const devToolRef = useRef<DevTool>('none')
  // Last LOG-inspector readout, shown in the dev HUD when no surface tool is armed. A ref, not
  // state: the render loop already owns that HUD line and reads it there each frame.
  const devInspectRef = useRef<string | null>(null)
  const armTool = (tool: DevTool) => {
    const next = devToolRef.current === tool ? 'none' : tool
    devToolRef.current = next
    setDevTool(next)
    devInspectRef.current = null // a tool takes over the readout
    if (next !== 'probe') controller.clearProbe()
  }
  const logSelected = () => {
    const d = controller.inspectSelected()
    if (!d) {
      devInspectRef.current = 'LOG — select an aircraft first'
      return
    }
    // The full record goes to the browser console to copy; the HUD gets the fields that decide
    // taxi routing and takeoff-vs-crossing, which is what the bug reports have been about.
    // eslint-disable-next-line no-console
    console.log(`[inspect ${d.callsign}]`, d)
    const p = (pt: readonly number[] | null) => (pt ? `[${pt[0]!.toFixed(2)},${pt[1]!.toFixed(2)}]` : '—')
    devInspectRef.current =
      `${d.callsign} ${d.type} ${d.intent} hs=${d.holdShort} tko=${d.holdingForTakeoff} ` +
      `cross=${d.heldRouteCrosses} luw=${d.lineUpWait} roll=${d.rollWhenLinedUp} dep=${d.departing} ` +
      `auth=${d.runwayAuth} onRwy=${d.onRunway} leg=${d.leg}/${d.path.length - 1} held=${d.held?.length ?? 0} ` +
      `goal=${p(d.goalPoint)} — full record in console`
  }
  // Dev sandbox: which airframe the next SPAWN/ARRIVAL uses. Local state mirrors the controller's
  // so the <select> is controlled; the groups are stable for the field, so memoize them.
  const [devType, setDevType] = useState<string>(() => controller.devType())
  const spawnTypeGroups = useMemo(() => controller.spawnTypeGroups(), [controller])
  const pickDevType = (designator: string) => {
    setDevType(designator)
    controller.setDevType(designator)
  }

  // Surface-derived draw data (feature buckets, label anchors) is static — compute it once,
  // not every animation frame (WEB-1). The surface never changes, so this never recomputes.
  const prep = useMemo(
    () => prepareSurface(airport.surface, airport.areaLabelOffsetsNm),
    [airport],
  )

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const sim = controller.sim

    let width = 0
    let height = 0
    let dpr = 1
    let view: View | null = null

    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      const newW = rect.width
      const newH = rect.height
      dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.round(newW * dpr)
      canvas.height = Math.round(newH * dpr)
      // First layout fits to bounds; later resizes/reflows preserve the controller's
      // pan/zoom by holding the world point at screen center (WEB-2).
      view = view ? reframe(view, width, height, newW, newH) : fitView(airport.surface.bounds, newW, newH)
      width = newW
      height = newH
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(canvas)

    // Active pointers (mouse or touch). One → pan/tap; two → pinch-zoom.
    const pointers = new Map<number, { x: number; y: number }>()
    let moved = false
    let downX = 0
    let downY = 0
    let pinchDist = 0
    let pinchCx = 0
    let pinchCy = 0
    // Mouse hover, for the route-mode preview of the taxiway a click would pick.
    let hoverX = -1
    let hoverY = -1
    let hovering = false

    const rectPt = (e: PointerEvent): { x: number; y: number } => {
      const r = canvas.getBoundingClientRect()
      return { x: e.clientX - r.left, y: e.clientY - r.top }
    }
    const pinchState = (): { dist: number; cx: number; cy: number } => {
      const [a, b] = [...pointers.values()]
      if (!a || !b) return { dist: 0, cx: 0, cy: 0 }
      return { dist: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 }
    }

    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      if (!view) return
      const rect = canvas.getBoundingClientRect()
      view = zoomAt(view, Math.exp(-e.deltaY * 0.0015), e.clientX - rect.left, e.clientY - rect.top)
    }
    const onDown = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return
      const p = rectPt(e)
      pointers.set(e.pointerId, p)
      canvas.setPointerCapture(e.pointerId)
      if (pointers.size === 1) {
        moved = false
        downX = p.x
        downY = p.y
      } else if (pointers.size === 2) {
        const s = pinchState()
        pinchDist = s.dist
        pinchCx = s.cx
        pinchCy = s.cy
        moved = true
      }
    }
    const onMove = (e: PointerEvent) => {
      const p = rectPt(e)
      if (e.pointerType === 'mouse') {
        hoverX = p.x
        hoverY = p.y
        hovering = true
      }
      const prev = pointers.get(e.pointerId)
      if (!prev || !view) return
      pointers.set(e.pointerId, p)
      if (pointers.size >= 2) {
        const s = pinchState()
        if (pinchDist > 0) {
          view = zoomAt(view, s.dist / pinchDist, s.cx, s.cy)
          view = pan(view, s.cx - pinchCx, s.cy - pinchCy)
        }
        pinchDist = s.dist
        pinchCx = s.cx
        pinchCy = s.cy
        moved = true
      } else {
        if (Math.hypot(p.x - downX, p.y - downY) > DRAG_PX) moved = true
        view = pan(view, p.x - prev.x, p.y - prev.y)
      }
    }
    const endPointer = (e: PointerEvent) => {
      const had = pointers.delete(e.pointerId)
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId)
      if (pointers.size < 2) pinchDist = 0
      if (had && pointers.size === 0 && !moved && view) handleClick(downX, downY)
    }
    const onLeave = () => {
      hovering = false
    }
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault()
      const id = controller.selectedId()
      if (id) controller.dispatch({ type: 'hold', aircraftId: id })
    }
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return // don't hijack keys meant for a focused text field
      const id = controller.selectedId()
      const draft = controller.routeDraft()
      if (e.key === ' ' && !(e.target instanceof HTMLButtonElement)) {
        e.preventDefault() // stop the page scrolling out from under the scope
        togglePause()
        return
      }
      if (e.key === 'Escape') {
        if (controller.dev && devToolRef.current !== 'none') {
          devToolRef.current = 'none'
          setDevTool('none')
          controller.clearProbe()
        } else if (draft) controller.clearRoute()
        else controller.select(null)
      } else if (controller.dev && (e.key === 'x' || e.key === 'X' || e.key === 'Delete') && id) {
        controller.removeSelected()
      } else if (e.key === 'Backspace' && draft) {
        e.preventDefault()
        controller.removeViaAt(draft.via.length - 1) // drop the last taxiway
      } else if ((e.key === 'c' || e.key === 'C') && id) {
        controller.dispatch({ type: 'crossRunway', aircraftId: id })
      } else if ((e.key === 'z' || e.key === 'Z') && id) {
        controller.focusOn(id) // keyboard equivalent of double-clicking the strip
      } else if (e.key === 'f' || e.key === 'F') {
        refitRef.current = true // frame the field + all traffic (incl. aircraft on final)
      } else if (controller.dev && (e.key === 'g' || e.key === 'G')) {
        // admin: toggle the routing-graph overlay (ref drives the loop; state drives the button)
        showGraphRef.current = !showGraphRef.current
        setShowGraph(showGraphRef.current)
      }
    }

    const toScreenSafe = (x: number, y: number): [number, number] => {
      if (!view) return [-1e6, -1e6]
      return [x * view.scale + view.offX, -y * view.scale + view.offY]
    }

    function handleClick(sx: number, sy: number): void {
      if (!view) return
      // Dev sandbox: an armed tool claims the click before select/taxi.
      const nearestAircraft = (): string | null => {
        const snap = sim.snapshot()
        let hit: string | null = null
        let hitDist = HIT_PX
        for (const a of snap.aircraft) {
          const [ax, ay] = toScreenSafe(a.x, a.y)
          const d = Math.hypot(ax - sx, ay - sy)
          if (d < hitDist) {
            hitDist = d
            hit = a.id
          }
        }
        return hit
      }
      if (controller.dev && devToolRef.current !== 'none') {
        if (devToolRef.current === 'delete') {
          // Stays armed: cleaning up after an over-eager SPAWN means clicking several away, and
          // toggling the mode back on between each would be exactly the friction this removes.
          const target = nearestAircraft()
          if (target) controller.remove(target)
        } else if (devToolRef.current === 'spawn') {
          const [wx, wy] = toWorld(view, sx, sy)
          controller.spawnAt([wx, wy])
        } else {
          const [wx, wy] = toWorld(view, sx, sy)
          controller.probeClick([wx, wy])
        }
        return
      }
      const hit = nearestAircraft()
      const selectedId = controller.selectedId()
      const draft = controller.routeDraft()
      if (hit) {
        controller.select(hit)
      } else if (draft) {
        // Route-building mode: a click on a taxiway appends it to the via-sequence.
        const [wx, wy] = toWorld(view, sx, sy)
        const ref = nearestTaxiwayRef(airport.surface, wx, wy, TAXI_HIT_PX / view.scale)
        if (ref) controller.addVia(ref)
      } else if (selectedId) {
        // A click only becomes a taxi clearance when it lands on (or near) pavement the aircraft
        // could actually be routed to. Without this test *every* miss was a clearance: the raw
        // point went to `taxiTo`, which snapped it to the nearest graph node however far away
        // that was, so a click on the grass or the bay silently re-routed the selection — and
        // took its give-way, expedite and diversion state with it. Nothing about clicking empty
        // space looks like issuing a clearance, which is why it read as the aircraft changing
        // its mind on its own. Off the network, a click means what it means with nothing
        // selected: deselect.
        const [wx, wy] = toWorld(view, sx, sy)
        if (distanceToNetworkNm(controller.topology, [wx, wy]) <= clearanceRangeNm(view.scale)) {
          controller.dispatch({ type: 'taxiTo', aircraftId: selectedId, dest: [wx, wy] })
        } else {
          controller.select(null)
        }
      } else {
        controller.select(null)
      }
    }

    canvas.addEventListener('wheel', onWheel, { passive: false })
    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointerup', endPointer)
    canvas.addEventListener('pointercancel', endPointer)
    canvas.addEventListener('pointerleave', onLeave)
    canvas.addEventListener('contextmenu', onContextMenu)
    window.addEventListener('keydown', onKey)

    let raf = 0
    let last = 0
    let started = false
    let acc = 0

    const frame = (t: number) => {
      if (!started) {
        last = t
        started = true
      }
      const t0 = tick(acc, (t - last) / 1000, speedRef.current)
      last = t
      acc = t0.acc
      for (let i = 0; i < t0.steps; i += 1) sim.step(FIXED_DT)
      controller.publish()

      if (view) {
        const snap = sim.snapshot()
        // Centre on an aircraft the strip bay (or the z key) asked for, keeping the zoom.
        // Resolved here rather than at the request site because the canvas owns the view.
        const focusId = controller.takeFocus()
        if (focusId) {
          const target = snap.aircraft.find((a) => a.id === focusId)
          if (target) view = centerOn(view, target.x, target.y, width, height)
        }
        if (refitRef.current) {
          refitRef.current = false
          // Frame the field plus every aircraft — including traffic still several nm out
          // on final, which sits far outside the surface bounds.
          view = fitPoints(
            airport.surface.bounds,
            snap.aircraft.map((a) => [a.x, a.y] as [number, number]),
            width,
            height,
          )
        }
        ctx.save()
        ctx.scale(dpr, dpr)
        const selectedId = controller.selectedId()
        const draft = controller.routeDraft()
        drawSurface(ctx, view, prep, width, height)
        drawAreaLabels(ctx, view, prep)
        drawGates(ctx, view, prep)
        drawRunwayMarkings(ctx, view, airport.layout)
        drawHotspots(ctx, view, airport.surface, snap.busyHotspots)
        drawApproachCourse(ctx, view, controller.approach())
        if (draft) {
          drawRouteDraft(ctx, view, airport.surface, draft.via)
          if (hovering) {
            const [wx, wy] = toWorld(view, hoverX, hoverY)
            const ref = nearestTaxiwayRef(airport.surface, wx, wy, TAXI_HIT_PX / view.scale)
            if (ref && !draft.via.includes(ref)) drawRouteHover(ctx, view, airport.surface, ref)
          }
        }
        // The painted designators replace the schematic map numbers once they're legible.
        drawLabels(ctx, view, prep, !runwayMarkingsVisible(view, airport.layout))
        drawAircraft(ctx, view, snap.aircraft)
        const selected = selectedId ? snap.aircraft.find((a) => a.id === selectedId) : undefined
        // Turnoffs are only meaningful for the arrival being worked, so they are drawn for the
        // selection rather than cluttering the runway permanently.
        if (selected && selectedId && selected.intent === 'arrival' && selected.controlledBy === 'tower') {
          drawRunwayExits(ctx, view, controller.exitOptions(selectedId), selected.exitRef)
        }
        // A selected arrival still heading for its stand: show where it is going, so a gate
        // conflict is visible before the aircraft ever gets there. Drops once it has parked.
        if (selected && selected.intent === 'arrival' && selected.gate && selected.status !== 'parked') {
          const stand = prep.standLines.find((s) => s.ref === selected.gate)
          if (stand) drawStandHighlight(ctx, view, stand)
        }
        drawSelection(ctx, view, selected, selectedId ? sim.routeOf(selectedId) : [])
        drawOffscreenTraffic(ctx, view, snap.aircraft, width, height)
        // Dev-only overlay: the toggle is gone outside the sandbox, so make sure a stale ref
        // can't leave it painted over a normal game.
        if (controller.dev && showGraphRef.current) drawGraphOverlay(ctx, view, controller.topology)
        if (controller.dev) {
          const pr = controller.probe()
          if (pr) drawProbe(ctx, view, pr)
          if (devToolRef.current === 'spawn' && hovering) {
            const [wx, wy] = toWorld(view, hoverX, hoverY)
            const s = controller.snap([wx, wy])
            if (s) drawSpawnPreview(ctx, view, s)
          }
          // Delete mode: ring the aircraft the next click would remove, so you never guess which
          // target in a cluster is about to go.
          if (devToolRef.current === 'delete' && hovering) {
            let target: GroundAircraft | null = null
            let best = HIT_PX
            for (const a of snap.aircraft) {
              const [ax, ay] = toScreenSafe(a.x, a.y)
              const d = Math.hypot(ax - hoverX, ay - hoverY)
              if (d < best) {
                best = d
                target = a
              }
            }
            if (target) {
              const [tx, ty] = toScreenSafe(target.x, target.y)
              ctx.strokeStyle = COLORS.conflict
              ctx.lineWidth = 1.5
              ctx.beginPath()
              ctx.arc(tx, ty, DIMS.targetR + 5, 0, Math.PI * 2)
              ctx.stroke()
            }
          }
        }
        ctx.restore()

        // Only write when the text actually changes: the status/hint/alert nodes are
        // aria-live regions, and re-assigning an identical string re-announces it.
        if (statusRef.current) {
          const moving = snap.aircraft.filter((a) => a.groundspeed > 0).length
          const mm = String(Math.floor(snap.time / 60)).padStart(2, '0')
          const ss = String(Math.floor(snap.time % 60)).padStart(2, '0')
          const onFinal = snap.aircraft.filter((a) => a.altitude > 0).length
          const surface = snap.aircraft.length - onFinal
          const final = onFinal > 0 ? ` · ${onFinal} on final` : ''
          const rate = speedRef.current === 0 ? ' · PAUSED' : speedRef.current === 1 ? '' : ` · ${speedRef.current}\u00d7`
          // Read-back errors caught, out of those made. Shown only once one has happened —
          // it is a score for a mechanic that may not have fired yet, and a permanent 0/0
          // would be a line about nothing. It is also the only place an *uncaught* one is
          // ever counted: catching it is silent by design, so this is the reckoning.
          const rb = snap.readbackErrors > 0 ? ` · R/B ${snap.readbackCaught}/${snap.readbackErrors}` : ''
          // Slots met, out of slots that mattered. Same rule as the read-back score beside it:
          // shown only once the mechanic has actually fired, so it is never a line about nothing.
          const slots = snap.slotsMet + snap.slotsMissed
          const edct = slots > 0 ? ` · EDCT ${snap.slotsMet}/${slots}` : ''
          setText(statusRef.current, `${moving} taxiing · ${surface} on surface${final} · dep ${snap.departed} · arr ${snap.arrived} · T+${mm}:${ss}${rate}${rb}${edct}`)
        }
        // Runway incursions top the alert stack: a conflict is two aircraft too close, this is
        // two aircraft on a runway, which is the one that ends the game rather than the shift.
        // The visible line and the announced one are different strings — see alerts.ts — so the
        // range can tick on screen without interrupting a screen reader every tenth of a mile.
        if (incursionRef.current && incursionMarkRef.current && incursionTextRef.current && incursionSrRef.current) {
          const alert = incursionAlert(snap.incursions)
          const el = incursionRef.current
          // The label text is the button's accessible name, so the two can never disagree —
          // the glyph beside it is aria-hidden and contributes nothing to the name.
          setText(incursionMarkRef.current, alert.mark)
          setText(incursionTextRef.current, alert.text)
          setText(incursionSrRef.current, alert.announcement)
          // Only pulse when there is something to pulse about, and only in the alert's colour
          // when it is an alert — an advisory is amber and still, like the gate line.
          el.classList.toggle('is-alert', alert.severity === 'alert')
          el.classList.toggle('is-advisory', alert.severity === 'advisory')
          incursionFocusRef.current = alert.focusId
          // Hidden rather than merely empty when there is nothing wrong: an empty button is
          // still a tab stop, and a tab stop that announces nothing is worse than no button.
          // If it is hiding out from under a keyboard user — the incursion resolved while they
          // were on it — hand focus back to the scope rather than dropping it on the floor.
          const hide = alert.focusId === null
          if (hide && !el.hidden && el.contains(document.activeElement)) canvas.focus()
          el.hidden = hide
        }
        // Taxi conflicts: the pair, and — while it is still developing — how long you have.
        // The sim names the hot spot in the message when there is one, because "where" is most
        // of what you need to act on. Split visible/announced: the countdown ticks.
        if (alertRef.current && alertSrRef.current) {
          const conflict = conflictAlert(snap.conflicts)
          setText(alertRef.current, conflict.text)
          setText(alertSrRef.current, conflict.announcement)
          alertRef.current.classList.toggle('is-converging', conflict.severity === 'advisory')
        }
        // Gate conflicts, field-wide: inbound arrivals heading for stands somebody is still
        // parked on. Deliberately a separate, quieter line — a separation conflict is happening
        // now, this has not happened yet, and colouring them the same would say otherwise.
        // Gates are named, not counted: the gate is what you act on, and there are only a few.
        if (gateAlertRef.current) {
          const gates = [...new Set(snap.aircraft.filter((a) => a.gateBlocked).map((a) => a.gate))]
          gates.sort()
          setText(gateAlertRef.current, gates.length > 0 ? `⧗ GATE ${gates.join(' · ')} OCCUPIED` : '')
        }
        // Aircraft you have left with nothing to do. The quietest line on the scope: nothing is
        // wrong yet, and an arrival sitting in its turnoff is a mistake still in the making.
        // Two nodes, for the same reason the incursion banner has two: the visible line carries
        // running clocks and changes every second, and a live region fed that would speak every
        // second. Only the announcement — who, not how long — reaches the live region.
        if (awaitingRef.current && awaitingSrRef.current) {
          const awaiting = awaitingAlert(snap.aircraft)
          setText(awaitingRef.current, awaiting.text)
          setText(awaitingSrRef.current, awaiting.announcement)
        }
        if (devRef.current && controller.dev) {
          let t = ''
          if (devToolRef.current === 'spawn') {
            t = 'SPAWN — click surface to place · X removes selected'
          } else if (devToolRef.current === 'delete') {
            t = 'DELETE — click aircraft to remove · Esc when done'
          } else if (devToolRef.current === 'probe') {
            const pr = controller.probe()
            if (!pr || !pr.to) t = 'PROBE — click origin, then destination'
            else if (pr.path.length >= 2)
              t = `PROBE ${pr.lengthNm.toFixed(2)} nm (${Math.round(pr.lengthNm * 6076)} ft) · ${pr.taxiways.join(' · ') || '—'}`
            else t = 'PROBE — no route between those points'
          } else if (devInspectRef.current) {
            t = devInspectRef.current
          }
          setText(devRef.current, t)
        }
        if (hintRef.current) {
          const notice = controller.notice()
          let hint: string
          if (notice) {
            hint = `⛔ ${notice}`
          } else if (draft && selected) {
            const via = draft.via.length ? `via ${draft.via.join(' · ')}` : '(none yet)'
            hint = `Routing ${selected.callsign} ${via} — click taxiways to add · tap a chip or Backspace to remove · pick a destination to issue · Esc to cancel`
          } else if (selected?.holdShort) {
            hint =
              selected.intent === 'departure'
                ? `${selected.callsign} holding short — use the strip's Contact tower (or C) to release for departure · Esc to deselect`
                : `${selected.callsign} holding short of the runway — press C to clear across · Esc to deselect`
          } else if (selected) {
            hint = `${selected.callsign} selected — click a point to assign taxi · right-click to hold · z centres on it · Esc to deselect`
          } else {
            hint = 'click an aircraft (scope or strip) to select · drag to pan · scroll to zoom'
          }
          setText(hintRef.current, hint)
        }
      }
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)

    return () => {
      cancelAnimationFrame(raf)
      observer.disconnect()
      canvas.removeEventListener('wheel', onWheel)
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerup', endPointer)
      canvas.removeEventListener('pointercancel', endPointer)
      canvas.removeEventListener('pointerleave', onLeave)
      canvas.removeEventListener('contextmenu', onContextMenu)
      window.removeEventListener('keydown', onKey)
    }
  }, [controller, prep])

  return (
    <div className="scope">
      <canvas
        ref={canvasRef}
        className="scope-canvas"
        tabIndex={0}
        role="application"
        aria-label={`${airport.icao} tower and ground radar: the airport surface plus the final approach. Tab to a flight strip to select and command an aircraft; drag to pan, scroll to zoom, press f to frame all traffic.`}
      />
      <div className="hud hud-tl">
        <div className="hud-title">
          {airport.icao} · {airport.name}
        </div>
        <div className="hud-sub">
          GND CON {airport.comms.ground} · TWR {airport.comms.tower} · D-ATIS {airport.comms.atis}
        </div>
      </div>
      <div className="hud hud-controls">
        {controller.dev && <span className="dev-tag mono">DEV</span>}
        <button
          type="button"
          className="ctl-btn mono"
          onClick={toggleRunway}
          title="Switch the active runway. Arrivals and departures always use the same direction."
        >
          RWY {activeRunway}
        </button>
        <button
          type="button"
          className="ctl-btn mono"
          onClick={requestRefit}
          title="Frame the airport and all traffic, including aircraft on final (f)"
        >
          ⤢ FIT
        </button>
        {/* Time control. A taxi across the field is minutes and ground servicing is 45 s, so
            watching it at 1x is most of the cost of play-testing at all. */}
        <span className="ctl-group" role="group" aria-label="Simulation rate">
          <button
            type="button"
            className="ctl-btn mono"
            aria-pressed={speed === 0}
            onClick={togglePause}
            title="Pause the simulation (Space). Clearances can still be issued while paused."
          >
            {speed === 0 ? '▶' : '❚❚'}
          </button>
          {SPEEDS.map((n) => (
            <button
              key={n}
              type="button"
              className="ctl-btn mono"
              aria-pressed={speed === n}
              onClick={() => applySpeed(n)}
              title={`Run at ${n}x`}
            >
              {n}&times;
            </button>
          ))}
        </span>
        {/* Traffic level. Not a difficulty setting so much as a play-testing one: at MOD the
            surface fills faster than one mechanic can be worked through by hand. Hidden in dev
            mode, which has no spawner to turn down. */}
        {!controller.dev && (
          <span className="ctl-group" role="group" aria-label="Traffic level">
            {TRAFFIC_LEVELS.map((level) => (
              <button
                key={level.label}
                type="button"
                className="ctl-btn mono"
                aria-pressed={trafficRate === level.rate}
                onClick={() => applyTrafficRate(level.rate)}
                title={
                  level.rate === 0
                    ? 'Generate no new traffic (aircraft already on the field stay)'
                    : `Generate ${level.label.toLowerCase()} traffic (${level.rate}× the field's normal rate)`
                }
              >
                {level.label}
              </button>
            ))}
          </span>
        )}
        {controller.dev && (
          <span className="ctl-group" role="group" aria-label="Developer tools">
            <button
              type="button"
              className="ctl-btn mono"
              aria-pressed={showGraph}
              onClick={toggleGraph}
              title="Toggle the routing-graph overlay (g)"
            >
              {showGraph ? '◆ GRAPH' : '◇ GRAPH'}
            </button>
            <label className="ctl-btn mono dev-type" title="Airframe the next SPAWN or ARRIVAL uses">
              TYPE
              <select
                className="mono dev-type-select"
                value={devType}
                onChange={(e) => pickDevType(e.target.value)}
              >
                {spawnTypeGroups.map((group) => (
                  <optgroup key={group.kind} label={group.kind.toUpperCase()}>
                    {group.types.map((t) => (
                      <option key={t.designator} value={t.designator}>
                        {t.designator} ({t.wake})
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="ctl-btn mono"
              aria-pressed={devTool === 'spawn'}
              onClick={() => armTool('spawn')}
              title="Click the surface to place a test aircraft (snaps to the nearest taxiway node)"
            >
              SPAWN
            </button>
            <button
              type="button"
              className="ctl-btn mono"
              aria-pressed={devTool === 'delete'}
              onClick={() => armTool('delete')}
              title="Click aircraft to remove them (stays armed for repeated cleanup)"
            >
              DELETE
            </button>
            <button
              type="button"
              className="ctl-btn mono"
              aria-pressed={devTool === 'probe'}
              onClick={() => armTool('probe')}
              title="Click two points to draw the routing path between them"
            >
              PROBE
            </button>
            <button
              type="button"
              className="ctl-btn mono"
              onClick={() => controller.spawnArrival()}
              title="Put a test arrival on the final approach (airborne — it can't be placed by clicking the surface)"
            >
              ARRIVAL
            </button>
            <button
              type="button"
              className="ctl-btn mono"
              onClick={logSelected}
              title="Log the selected aircraft's internal routing/runway state to the console (and the readout above)"
            >
              LOG
            </button>
            <button
              type="button"
              className="ctl-btn mono"
              onClick={() => controller.clearAll()}
              title="Remove all aircraft"
            >
              CLEAR
            </button>
          </span>
        )}
        {/* Shares the control bar's row so the two can't collide as the bar grows. */}
        <div ref={hintRef} className="hud-hint mono" aria-live="polite" />
      </div>
      {controller.dev && <div ref={devRef} className="hud hud-dev mono" aria-live="polite" />}
      <div ref={statusRef} className="hud hud-tr mono" />
      {/* Two nodes for one alert. The visible one is a button — naming an aircraft and not
          taking you to it is half an alert — and its label text *is* its accessible name, so a
          speech-input user can say what they see. The off-screen twin is the live region that
          does the announcing, and only it; keeping the two apart is what lets the visible line
          repaint with a ticking range without interrupting a screen reader on every tenth of
          a mile. */}
      <button
        ref={incursionRef}
        type="button"
        className="hud hud-incursion mono"
        hidden
        onClick={() => {
          const id = incursionFocusRef.current
          // Re-check against the live fleet: the banner is painted a frame ahead of the click,
          // and an aircraft can leave the sim in between. Selecting an id that no longer exists
          // would leave the bay pointed at nothing.
          if (!id || !controller.sim.snapshot().aircraft.some((a) => a.id === id)) return
          controller.select(id)
          controller.focusOn(id)
        }}
      >
        <span ref={incursionMarkRef} aria-hidden="true" />
        <span ref={incursionTextRef} />
      </button>
      <div ref={incursionSrRef} className="sr-only" role="alert" />
      <div ref={alertRef} className="hud hud-alert mono" aria-hidden="true" />
      <div ref={alertSrRef} className="sr-only" role="alert" />
      {/* Advisory, not an alarm: polite rather than role="alert", so it never cuts across the
          separation conflict above it. */}
      <div ref={gateAlertRef} className="hud hud-gate-alert mono" aria-live="polite" />
      <div ref={awaitingRef} className="hud hud-awaiting mono" aria-hidden="true" />
      <div ref={awaitingSrRef} className="sr-only" aria-live="polite" />
    </div>
  )
}
