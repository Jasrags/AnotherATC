import type { ControllerPosition, GroundCommand } from './types'

/**
 * Radio phraseology for the communications log.
 *
 * Every accepted clearance is a *transmission pair*: what the controller said, and what the
 * pilot read back. Keeping the wording here — pure, in the sim, beside the commands it phrases —
 * means the transcript can never drift from what the simulation actually did, and the same
 * exchange is available to a future read-back-verification mechanic (which needs the correct
 * read-back in order to generate a wrong one).
 *
 * Wording follows FAA Order 7110.65 / AIM Ch. 4 conventions: the callsign leads an instruction
 * and trails a read-back, and the runway is stated before a takeoff, line-up or landing clearance.
 */

export type TransmissionFrom = 'controller' | 'pilot'

/** How many transmissions the sim keeps. A session runs indefinitely; the transcript is a
 *  scrollback, not a permanent record, so it is a ring rather than an unbounded array. */
export const COMMS_LOG_LIMIT = 200

/** One radio call, timestamped in simulated seconds. */
/** Sim-clock time as the scope shows it (mm:ss) — what an EDCT is quoted against, since the
 *  sim has no wall clock and the header already counts in this. */
export function clockTime(sec: number): string {
  const m = Math.floor(Math.max(0, sec) / 60)
  const s = Math.floor(Math.max(0, sec) % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

export interface Transmission {
  /** Monotonic sequence number — stable ordering independent of equal timestamps. */
  seq: number
  /** Simulated time (s) of the call. */
  time: number
  from: TransmissionFrom
  /** The frequency it happened on: whichever position owned the aircraft at the time. */
  position: ControllerPosition
  aircraftId: string
  callsign: string
  text: string
}

const ALPHABET: Record<string, string> = {
  A: 'Alpha',
  B: 'Bravo',
  C: 'Charlie',
  D: 'Delta',
  E: 'Echo',
  F: 'Foxtrot',
  G: 'Golf',
  H: 'Hotel',
  I: 'India',
  J: 'Juliett',
  K: 'Kilo',
  L: 'Lima',
  M: 'Mike',
  N: 'November',
  O: 'Oscar',
  P: 'Papa',
  Q: 'Quebec',
  R: 'Romeo',
  S: 'Sierra',
  T: 'Tango',
  U: 'Uniform',
  V: 'Victor',
  W: 'Whiskey',
  X: 'Xray',
  Y: 'Yankee',
  Z: 'Zulu',
}

/** Spoken form of a taxiway designator: "A" → "Alpha", "B4" → "Bravo 4". Anything that isn't a
 *  letter with an optional number (a hot-spot id, say) is passed through untouched. */
export function phonetic(ref: string): string {
  const m = /^([A-Z])(\d*)$/.exec(ref.toUpperCase())
  if (!m) return ref
  const word = ALPHABET[m[1] as string]
  if (!word) return ref
  return m[2] ? `${word} ${m[2]}` : word
}

const cap = (s: string): string => `${s.charAt(0).toUpperCase()}${s.slice(1)}`

/** Everything the phrasing needs about the aircraft *after* the command took effect. */
export interface PhraseContext {
  callsign: string
  /** Active runway designator without a leading zero, e.g. "27" or "9". */
  runway: string | null
  squawk: string | null
  /** The wheels-up time this clearance carries, already formatted (see {@link clockTime}), or
   *  null when the flight is unconstrained. */
  edct: string | null
  /** An aircraft is landing on this runway right now — issued with a line-up, which is the one
   *  instruction that sends an aircraft onto a runway something else is still using. */
  landingTraffic: boolean
  /** Callsign this line-up is *conditional* on, or null for an ordinary one. */
  lineUpBehind: string | null
  /** Named taxiways of the current route, in order. */
  taxiways: readonly string[]
  /** Where the clearance ends, already worded: "runway 27", "gate 39". */
  destination: string | null
  /** Callsign of the traffic being given way to. */
  giveWayTo: string | null
  towerFreq: string | null
  groundFreq: string | null
  /** Arrival is already clear of the runway (drops the "when vacated" qualifier). */
  vacated: boolean
  /** Compass point the aircraft is being pushed back to face, when one applies. */
  pushFacing: string | null
  /** Which position is transmitting. Local Control and Ground say some of the same things
   *  differently — a crossing Tower issues carries "no delay", Ground's does not. */
  position: ControllerPosition
  /** This aircraft is holding short to *cross* rather than to depart, which changes what a
   *  handoff to Tower is for and what handing it back to Ground means. */
  crossing: boolean
  /** Still physically on the runway — a handoff issued now is "when clear of the runway…". */
  onRunway: boolean
  /** Designator of the runway this aircraft's clearance stops short of, or null. The clause a
   *  taxi clearance has to carry, and which the procedure makes mandatory to read back. */
  holdingShortOf: string | null
  /** The runway a crossing or hold-short clearance is *about* — the one being crossed — spoken. On a
   *  multi-runway field this is not the aircraft's own runway ({@link runway}): an arrival that
   *  landed on 28R crosses runway 10R/28L to reach its gate, and the clearance names the runway it
   *  crosses, not the one it landed on. Null when the clearance is about the aircraft's own runway. */
  crossingRunway: string | null
  /** Why this aircraft is being held, worded for the air ("traffic on a 3 mile final"), or null
   *  when nothing is in the way. A cause, not a clearance — it is transmitted with the
   *  instruction and deliberately absent from the read-back. */
  holdReason: string | null
}

/** A controller instruction and the pilot's correct read-back of it. */
export interface Exchange {
  instruction: string
  readback: string
}

/** Re-issue an instruction as a correction: "SKW412, negative, cleared to …". The callsign
 *  always leads an instruction, so the qualifier goes straight after it. */
export function negative(instruction: string): string {
  return instruction.replace(', ', ', negative, ')
}

/** A beacon code with one octal digit misheard — the classic read-back error. Deterministic:
 *  two independent rolls (0–1) pick which digit and by how much, so which digit is wrong does
 *  not determine how wrong it is. Always changes exactly one digit. */
export function misheardSquawk(code: string, digitRoll: number, deltaRoll: number): string {
  const digits = [...code]
  const index = Math.min(digits.length - 1, Math.floor(digitRoll * digits.length))
  const delta = 1 + Math.min(6, Math.floor(deltaRoll * 7))
  const digit = Number.parseInt(digits[index] as string, 8)
  digits[index] = ((digit + delta) % 8).toString(8)
  return digits.join('')
}

/** The exchange for an accepted command, or null for one nobody says out loud. */
export function phraseFor(cmd: GroundCommand, ctx: PhraseContext): Exchange | null {
  const cs = ctx.callsign
  const rwy = ctx.runway ? `runway ${ctx.runway}` : 'the runway'
  const Rwy = cap(rwy)
  // A crossing/hold-short clearance names the runway being crossed, which on a multi-runway field
  // is not the aircraft's own runway. Falls back to the own runway (single-runway fields, and a
  // departure holding short of its destination runway).
  const crossRwy = ctx.crossingRunway ? `runway ${ctx.crossingRunway}` : rwy
  const via = ctx.taxiways.length ? ` via ${ctx.taxiways.map(phonetic).join(', ')}` : ''
  const say = (instruction: string, readback: string): Exchange => ({
    instruction: `${cs}, ${instruction}.`,
    readback: `${readback}, ${cs}.`,
  })

  switch (cmd.type) {
    case 'clearance': {
      const code = ctx.squawk ?? 'standby'
      // The slot rides on the clearance because that is where flow puts it — the aircraft is
      // told when it must be airborne before it has been told it may move.
      const edct = ctx.edct ? `, EDCT ${ctx.edct}` : ''
      return say(
        `cleared to destination as filed, squawk ${code}${edct}`,
        `Cleared as filed, squawk ${code}${edct}`,
      )
    }
    case 'assignStand':
      return say(`gate ${cmd.ref}`, `Gate ${cmd.ref}`)
    case 'pushback': {
      const face = ctx.pushFacing ? ` facing ${ctx.pushFacing}` : ''
      return say(`push and start approved${face}`, `Push and start approved${face}`)
    }
    case 'taxiTo':
    case 'taxiToGoal':
    case 'taxiVia':
    case 'taxiViaGoal': {
      const dest = ctx.destination ? ` to ${ctx.destination}` : ''
      // "…, hold short of runway 27". Not decoration: a clearance to a destination never
      // authorizes crossing anything on the way, and this is the clause that says so — the one
      // the pilot must read back verbatim (docs/atc-runway-crossing.md §2–3).
      const short = ctx.holdingShortOf ? `, hold short of runway ${ctx.holdingShortOf}` : ''
      return say(
        `taxi${dest}${via}${short}`,
        `${ctx.destination ? cap(ctx.destination) : 'Taxi'}${via}${short}`,
      )
    }
    case 'holdShort':
      // The reason rides on the instruction and not on the read-back: a pilot reads back what
      // they must comply with, and "traffic on a 3 mile final" is why, not what.
      return say(`hold short of ${crossRwy}${ctx.holdReason ? `, ${ctx.holdReason}` : ''}`, `Hold short of ${crossRwy}`)
    case 'hold':
      return say('hold position', 'Hold position')
    case 'resume':
      return say('continue taxi', 'Continue taxi')
    case 'crossRunway': {
      // Local Control owns the runway, and its crossing clearance carries the instruction that
      // says so: get across and get off. "No delay" is phraseology, not emphasis.
      const delay = ctx.position === 'tower' ? ', no delay' : ''
      return say(`cross ${crossRwy}${delay}`, `Cross ${crossRwy}${delay}`)
    }
    case 'giveWay': {
      const traffic = ctx.giveWayTo ?? 'the traffic'
      return say(`give way to ${traffic}`, `Give way to ${traffic}`)
    }
    case 'lineUpAndWait': {
      // Conditional: the ICAO sandwich (Doc 4444) — the condition is stated *before* the
      // clearance and repeated *after* it, so it cannot be heard as an unconditional line-up
      // by an aircraft that misses the first three words. The read-back repeats both, which is
      // the whole safety case for permitting a conditional clearance at all.
      if (cmd.behind !== undefined && ctx.lineUpBehind) {
        const behind = `behind the landing ${ctx.lineUpBehind}`
        return say(`${behind}, ${rwy}, line up and wait, behind`, `${cap(behind)}, ${rwy}, line up and wait, behind`)
      }
      // The traffic rides on the instruction, not on a separate call: it is the reason this
      // clearance is safe, and a pilot entering a runway hears the two together or not at all.
      const traffic = ctx.landingTraffic ? `, traffic landing ${rwy}` : ''
      return say(`${rwy}, line up and wait${traffic}`, `${Rwy}, line up and wait`)
    }
    case 'clearedForTakeoff':
      return say(`${rwy}, cleared for takeoff`, `${Rwy}, cleared for takeoff`)
    case 'clearedToLand':
      return say(`${rwy}, cleared to land`, `${Rwy}, cleared to land`)
    case 'goAround':
      // An instruction with a read-back. The pilot's own go-around is a single announcement
      // transmitted elsewhere — the transcript has to be able to tell the two apart.
      return say('go around', 'Going around')
    case 'expedite':
      return say('expedite', 'Expediting')
    case 'assignExit': {
      const exit = phonetic(cmd.ref)
      return say(`turn off at ${exit}`, exit)
    }
    case 'contactTower': {
      const freq = ctx.towerFreq ? ` ${ctx.towerFreq}` : ''
      // The handoff names its purpose, because the two are different operations: a departure is
      // going to use the runway, a transit is going to cross it.
      const why = ctx.crossing ? ` for ${rwy} crossing` : ''
      return say(`contact tower${freq}${why}`, `Contact tower${freq}${why}`)
    }
    case 'contactGround': {
      const freq = ctx.groundFreq ? ` ${ctx.groundFreq}` : ''
      // Three shapes, because the aircraft is in one of three states: mid-crossing (not off the
      // pavement yet), across (Tower says so as it hands back), or a landing rollout.
      if (ctx.crossing) {
        const when = ctx.onRunway ? 'when clear of the runway, ' : `${rwy} clear, `
        return say(`${when}contact ground${freq}`, `${cap(when)}contact ground${freq}`)
      }
      const when = ctx.vacated ? '' : 'when vacated, '
      return say(`${when}contact ground${freq}`, `${when ? 'When vacated, ' : ''}contact ground${freq}`)
    }
    default:
      return null
  }
}
