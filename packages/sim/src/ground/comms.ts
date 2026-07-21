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
  /** Named taxiways of the current route, in order. */
  taxiways: readonly string[]
  /** Where the clearance ends, already worded: "runway 27", "gate 39". */
  destination: string | null
  /** Callsign of the traffic being given way to. */
  giveWayTo: string | null
  exitRef: string | null
  towerFreq: string | null
  groundFreq: string | null
  /** Arrival is already clear of the runway (drops the "when vacated" qualifier). */
  vacated: boolean
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
 *  `roll` (0–1) picks which digit and by how much, so a seeded sim mishears reproducibly. */
export function misheardSquawk(code: string, roll: number): string {
  const digits = [...code]
  const index = Math.min(digits.length - 1, Math.floor(roll * digits.length))
  const delta = 1 + Math.floor(roll * 7) % 7
  const digit = Number.parseInt(digits[index] as string, 8)
  digits[index] = ((digit + delta) % 8).toString(8)
  return digits.join('')
}

/** The exchange for an accepted command, or null for one nobody says out loud. */
export function phraseFor(cmd: GroundCommand, ctx: PhraseContext): Exchange | null {
  const cs = ctx.callsign
  const rwy = ctx.runway ? `runway ${ctx.runway}` : 'the runway'
  const Rwy = cap(rwy)
  const via = ctx.taxiways.length ? ` via ${ctx.taxiways.map(phonetic).join(', ')}` : ''
  const say = (instruction: string, readback: string): Exchange => ({
    instruction: `${cs}, ${instruction}.`,
    readback: `${readback}, ${cs}.`,
  })

  switch (cmd.type) {
    case 'clearance': {
      const code = ctx.squawk ?? 'standby'
      return say(`cleared to destination as filed, squawk ${code}`, `Cleared as filed, squawk ${code}`)
    }
    case 'pushback':
      return say('push and start approved', 'Push and start approved')
    case 'taxiTo':
    case 'taxiToGoal':
    case 'taxiVia':
    case 'taxiViaGoal': {
      const dest = ctx.destination ? ` to ${ctx.destination}` : ''
      return say(`taxi${dest}${via}`, `${ctx.destination ? cap(ctx.destination) : 'Taxi'}${via}`)
    }
    case 'hold':
      return say('hold position', 'Hold position')
    case 'resume':
      return say('continue taxi', 'Continue taxi')
    case 'crossRunway':
      return say(`cross ${rwy}`, `Cross ${rwy}`)
    case 'giveWay': {
      const traffic = ctx.giveWayTo ?? 'the traffic'
      return say(`give way to ${traffic}`, `Give way to ${traffic}`)
    }
    case 'lineUpAndWait':
      return say(`${rwy}, line up and wait`, `${Rwy}, line up and wait`)
    case 'clearedForTakeoff':
      return say(`${rwy}, cleared for takeoff`, `${Rwy}, cleared for takeoff`)
    case 'clearedToLand':
      return say(`${rwy}, cleared to land`, `${Rwy}, cleared to land`)
    case 'assignExit': {
      const exit = phonetic(cmd.ref)
      return say(`turn off at ${exit}`, exit)
    }
    case 'contactTower': {
      const freq = ctx.towerFreq ? ` ${ctx.towerFreq}` : ''
      return say(`contact tower${freq}`, `Contact tower${freq}`)
    }
    case 'contactGround': {
      const freq = ctx.groundFreq ? ` ${ctx.groundFreq}` : ''
      const when = ctx.vacated ? '' : 'when vacated, '
      return say(`${when}contact ground${freq}`, `${when ? 'When vacated, ' : ''}contact ground${freq}`)
    }
    default:
      return null
  }
}
