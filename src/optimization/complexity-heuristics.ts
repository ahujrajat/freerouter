import type { Message } from '../types.js'

export interface ComplexityFeatures {
  tokens: number
  instructions: number
  codeBlocks: number
  codeChars: number
  formatConstraints: number
  reasoningMarkers: number
  nestingDepth: number
  constraintWords: number
  referenceMarkers: number
}

export interface HeuristicWeights {
  tokens: number
  instructions: number
  code: number
  format: number
  reasoning: number
  constraints: number
  references: number
}

export interface ComplexityScore {
  features: ComplexityFeatures
  normalized: Record<keyof ComplexityFeatures, number>
  score: number
}

export const DEFAULT_WEIGHTS: HeuristicWeights = {
  tokens:       0.15,
  instructions: 0.20,
  code:         0.15,
  format:       0.15,
  reasoning:    0.20,
  constraints:  0.10,
  references:   0.05,
}

/** Mid-point of each feature's "complex" curve. Tunable by the offline pipeline. */
export interface SaturationConstants {
  tokens: number
  instructions: number
  codeChars: number
  format: number
  reasoning: number
  nesting: number
  constraints: number
  references: number
}

export const DEFAULT_SATURATION: SaturationConstants = {
  tokens: 800,
  instructions: 5,
  codeChars: 400,
  format: 3,
  reasoning: 4,
  nesting: 3,
  constraints: 4,
  references: 3,
}

// ── Pre-compiled patterns (allocated once per module load) ──────────────────

const RE_CODE_FENCE  = /```\w*[\s\S]*?```/g
const RE_INLINE_CODE = /`[^`\n]+`/g
const RE_NUMBERED    = /^\s*\d+[.)]\s+\S/gm
const RE_SENTENCE_END = /[.!?](\s+|$)/g

const RE_IMPERATIVE = new RegExp(
  '\\b(' + [
    'write','create','generate','build','design','implement',
    'analyze','compare','explain','describe','summarize','extract',
    'convert','translate','refactor','optimize','fix','debug','review',
    'evaluate','classify','score','rank','identify','determine',
    'calculate','compute','derive','prove','verify','validate','list',
  ].join('|') + ')\\b', 'gi')

const RE_FORMAT_HINT = new RegExp(
  '\\b(respond\\s+(in|with)|format\\s+as|output\\s+(as|in)|' +
  'return\\s+(a|an|the)|reply\\s+with|' +
  'in\\s+(json|xml|yaml|markdown|csv)|' +
  'as\\s+a?\\s*(json|xml|yaml|table|list|csv))\\b', 'gi')

const RE_JSON_SHAPE  = /\{[^{}]*"[\w-]+"\s*:/g
const RE_XML_TAG     = /<\/?[a-zA-Z][\w-]*\s*\/?>/g

const RE_REASONING = new RegExp(
  '\\b(think|reason|analyze|step[- ]by[- ]step|walk\\s+through|' +
  'explain\\s+why|justify|prove|derive|infer|deduce|conclude|' +
  'because|therefore|hence|implication|trade[- ]?off|' +
  'compare\\s+and\\s+contrast|pros\\s+and\\s+cons)\\b', 'gi')

const RE_CONSTRAINT = new RegExp(
  "\\b(must(\\s+not)?|do\\s+not|don'?t|never|always|only|exactly|" +
  'at\\s+least|at\\s+most|no\\s+more\\s+than|fewer\\s+than|' +
  "cannot|can'?t|required|mandatory|forbidden|prohibited)\\b", 'gi')

const RE_REFERENCE = new RegExp(
  '\\b(the\\s+above|as\\s+(mentioned|stated|noted|described|i\\s+said)|' +
  'previously|earlier|aforementioned|' +
  'that\\s+(file|function|class|variable|line|snippet)|' +
  'the\\s+(previous|prior)|in\\s+the\\s+context)\\b', 'gi')

// ── Extractors ──────────────────────────────────────────────────────────────

function countMatches(re: RegExp, s: string): number {
  re.lastIndex = 0
  let n = 0
  while (re.exec(s) !== null) n++
  return n
}

function codeCharCount(s: string): { fences: number; chars: number } {
  RE_CODE_FENCE.lastIndex = 0
  let chars = 0, fences = 0, m: RegExpExecArray | null
  while ((m = RE_CODE_FENCE.exec(s)) !== null) { fences++; chars += m[0].length }
  RE_INLINE_CODE.lastIndex = 0
  while ((m = RE_INLINE_CODE.exec(s)) !== null) chars += m[0].length
  return { fences, chars }
}

function maxIndentDepth(s: string): number {
  let max = 0, lineStart = 0
  for (let i = 0; i <= s.length; i++) {
    if (i === s.length || s.charCodeAt(i) === 10) {
      let indent = 0, j = lineStart
      while (j < i) {
        const c = s.charCodeAt(j)
        if (c === 32) indent += 1
        else if (c === 9) indent += 2
        else break
        j++
      }
      if (j < i && indent > max) max = indent
      lineStart = i + 1
    }
  }
  return Math.floor(max / 2)
}

function flatten(messages: readonly Message[]): string {
  let out = ''
  for (const m of messages) { out += m.content; out += '\n\n' }
  return out
}

export function extractFeatures(messages: readonly Message[]): ComplexityFeatures {
  const text = flatten(messages)
  const { fences, chars: codeChars } = codeCharCount(text)
  const imperatives = countMatches(RE_IMPERATIVE, text)
  const numbered    = countMatches(RE_NUMBERED,   text)
  const sentences   = Math.max(1, countMatches(RE_SENTENCE_END, text))
  const instructions = Math.max(numbered, Math.min(imperatives, sentences))

  const formatHints  = countMatches(RE_FORMAT_HINT, text)
  const schemaShapes = countMatches(RE_JSON_SHAPE, text)
  const xmlTags      = Math.min(countMatches(RE_XML_TAG, text), 10)

  const indentDepth = maxIndentDepth(text)
  const listDepth   = numbered > 5 ? 2 : numbered > 1 ? 1 : 0

  return {
    tokens: Math.ceil(text.length / 4),
    instructions,
    codeBlocks: fences,
    codeChars,
    formatConstraints: formatHints + schemaShapes + xmlTags,
    reasoningMarkers: countMatches(RE_REASONING, text),
    nestingDepth: Math.max(indentDepth, listDepth),
    constraintWords: countMatches(RE_CONSTRAINT, text),
    referenceMarkers: countMatches(RE_REFERENCE, text),
  }
}

const sat = (x: number, k: number): number => x / (x + k)

export function score(
  features: ComplexityFeatures,
  weights: HeuristicWeights = DEFAULT_WEIGHTS,
  saturation: SaturationConstants = DEFAULT_SATURATION,
): ComplexityScore {
  const n = {
    tokens:            sat(features.tokens,            saturation.tokens),
    instructions:      sat(features.instructions,      saturation.instructions),
    codeBlocks:        sat(features.codeBlocks * 50 + features.codeChars, saturation.codeChars),
    codeChars:         sat(features.codeChars,         saturation.codeChars),
    formatConstraints: sat(features.formatConstraints, saturation.format),
    reasoningMarkers:  sat(features.reasoningMarkers,  saturation.reasoning),
    nestingDepth:      sat(features.nestingDepth,      saturation.nesting),
    constraintWords:   sat(features.constraintWords,   saturation.constraints),
    referenceMarkers:  sat(features.referenceMarkers,  saturation.references),
  }

  const composite =
      weights.tokens       * n.tokens
    + weights.instructions * n.instructions
    + weights.code         * n.codeBlocks
    + weights.format       * n.formatConstraints
    + weights.reasoning    * n.reasoningMarkers
    + weights.constraints  * n.constraintWords
    + weights.references   * n.referenceMarkers

  return { features, normalized: n, score: Math.min(composite, 1) }
}
