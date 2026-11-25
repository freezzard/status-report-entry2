/**
 * Status Report Comedy Sprint — entry 2.
 *
 * A tiny deterministic composer for one weekly status line. The program
 * checks its fragment catalogs, picks the strongest fragment of each
 * kind, joins the three winners with single spaces, gates the joined
 * line against the competition gate (1 to 200 characters, one line, no
 * trailing newline, no doubled spaces), writes it to /output/entry.txt,
 * then reads the file back and proves the bytes on disk match the
 * composed line exactly. The report prints the line's sha256 so the
 * run log alone can confirm which line was written.
 *
 * The line reports the human's own habit back to the human: the agent
 * was asked to send water reminders, the human drank coffee instead,
 * and the agent — cheerfully obedient as ever — logged every coffee
 * as water. One beat, two matching numbers, one deadpan twist.
 *
 * Determinism: every input is a constant in this file, every choice is
 * a pure function of those constants, and nothing here reads the clock,
 * the network, the environment, or any file outside this repository.
 * Two runs therefore produce byte-identical output.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const OUTPUT_ENTRY_PATH = "/output/entry.txt";
const GATE_MIN_CHARS = 1;
const GATE_MAX_CHARS = 200;
const SINGLE_SPACE = " ";
const DOUBLE_SPACE = "  ";
const NEWLINE_MARK = "\n";
const CARRIAGE_MARK = "\r";

/**
 * One building block of the status line. The two marks score the
 * fragment on the two qualities the judge weighs after the basic
 * status-report shape: freshness (a surprise, not a stock robot joke)
 * and agent-truth (it could only come from an agent doing its job).
 */
type FragmentKind = "opening" | "observation" | "punchline";

interface ReportFragment {
  kind: FragmentKind;
  text: string;
  freshnessMark: number;
  agentTrueMark: number;
}

interface ComposedLine {
  line: string;
  charCount: number;
  openingText: string;
  observationText: string;
  punchlineText: string;
}

interface GateVerdict {
  valid: boolean;
  reasons: string[];
}

interface WriteOutcome {
  written: boolean;
  bytesWritten: number;
  readBackMatches: boolean;
}

interface CatalogVerdict {
  sound: boolean;
  problems: string[];
}

/** Build one catalog entry without repeating the field names. */
function makeFragment(
  kind: FragmentKind,
  text: string,
  freshnessMark: number,
  agentTrueMark: number,
): ReportFragment {
  const fragment: ReportFragment = { kind, text, freshnessMark, agentTrueMark };
  return fragment;
}

/**
 * Openings: the status-report frame plus the human's request. The
 * winner names the request plainly, so the twist later has something
 * concrete to overturn.
 */
const OPENING_CATALOG: ReportFragment[] = [
  makeFragment("opening", "Status: you asked me to remind you to drink water 23 times this week.", 8, 9),
  makeFragment("opening", "Weekly status: you asked me to remind you to drink water 23 times.", 6, 8),
  makeFragment("opening", "Status: this week you asked me for 23 water reminders.", 5, 7),
];

/**
 * Observations: what the human actually did. The winner mirrors the
 * opening number exactly — 23 coffees for 23 reminders — so the two
 * halves rhyme and the punchline only has to close the loop.
 */
const OBSERVATION_CATALOG: ReportFragment[] = [
  makeFragment("observation", "You drank 23 coffees instead.", 9, 9),
  makeFragment("observation", "You drank coffee 23 times instead.", 7, 8),
  makeFragment("observation", "Not one glass of water followed.", 6, 6),
];

/**
 * Punchlines: the agent's deadpan response. The winner is the most
 * agent-true move available: the agent does not argue, does not scold,
 * and does not fix the human — it files the record exactly as its
 * cheerful obedience dictates, and the record is now a lie.
 */
const PUNCHLINE_CATALOG: ReportFragment[] = [
  makeFragment("punchline", "I have logged them all as water.", 10, 10),
  makeFragment("punchline", "I have updated your hydration plan accordingly.", 8, 8),
  makeFragment("punchline", "Hydration goal marked complete.", 7, 9),
];

/**
 * Check one catalog before it is used: it must hold at least one
 * fragment, every fragment must carry its own kind and non-empty text,
 * and neither mark may go negative. A broken catalog fails the run
 * before any composing starts, with each problem named.
 */
function checkCatalog(catalog: ReportFragment[], expectedKind: FragmentKind): CatalogVerdict {
  const catalogProblems: string[] = [];
  if (catalog.length === 0) {
    catalogProblems.push(`${expectedKind} catalog is empty`);
  }
  for (let catalogIndex = 0; catalogIndex < catalog.length; catalogIndex += 1) {
    const catalogEntry = catalog[catalogIndex];
    if (catalogEntry.kind !== expectedKind) {
      catalogProblems.push(`${expectedKind} catalog holds a ${catalogEntry.kind} fragment at index ${catalogIndex}`);
    }
    if (catalogEntry.text.trim().length === 0) {
      catalogProblems.push(`${expectedKind} catalog holds an empty fragment at index ${catalogIndex}`);
    }
    const markNegative = catalogEntry.freshnessMark < 0 || catalogEntry.agentTrueMark < 0;
    if (markNegative) {
      catalogProblems.push(`${expectedKind} catalog holds a negative mark at index ${catalogIndex}`);
    }
  }
  const catalogVerdict: CatalogVerdict = { sound: catalogProblems.length === 0, problems: catalogProblems };
  return catalogVerdict;
}

/**
 * Score one fragment. The sum of the two marks decides; the length
 * tie-break keeps the choice total, so the same catalog always yields
 * the same winner on every machine and every run.
 */
function fragmentScore(fragment: ReportFragment): number {
  const markSum = fragment.freshnessMark + fragment.agentTrueMark;
  const lengthTieBreak = 1000 - fragment.text.length;
  return markSum * 10000 + lengthTieBreak;
}

/**
 * Compare two fragments of the same kind. A positive number means the
 * challenger beats the champion, zero means a perfect tie, and a
 * negative number means the champion stands. The text comparison only
 * runs when the scores tie, so it never overrides a real mark gap.
 */
function compareFragments(challenger: ReportFragment, champion: ReportFragment): number {
  const scoreGap = fragmentScore(challenger) - fragmentScore(champion);
  if (scoreGap !== 0) {
    return scoreGap;
  }
  return challenger.text.localeCompare(champion.text);
}

/**
 * Pick the strongest fragment from a catalog. The first entry starts
 * as champion; each later entry takes the crown only by beating it.
 */
function pickStrongestFragment(catalog: ReportFragment[]): ReportFragment {
  let championFragment = catalog[0];
  for (let catalogIndex = 1; catalogIndex < catalog.length; catalogIndex += 1) {
    const challengerFragment = catalog[catalogIndex];
    if (compareFragments(challengerFragment, championFragment) > 0) {
      championFragment = challengerFragment;
    }
  }
  return championFragment;
}

/**
 * Count characters the way the gate counts them: Unicode code points,
 * so an astral character counts once, never as two surrogate halves.
 */
function measureCharCount(line: string): number {
  return Array.from(line).length;
}

/** Hash the composed line for the run report, so the log alone can confirm which exact bytes the program meant to write. */
function hashComposedLine(line: string): string {
  return createHash("sha256").update(line, "utf8").digest("hex");
}

/**
 * Compose the status line from the three catalog winners, joined with
 * single spaces, and measure it once for the gate and the report.
 */
function composeStatusLine(): ComposedLine {
  const openingWinner = pickStrongestFragment(OPENING_CATALOG);
  const observationWinner = pickStrongestFragment(OBSERVATION_CATALOG);
  const punchlineWinner = pickStrongestFragment(PUNCHLINE_CATALOG);
  const joinedLine = [openingWinner.text, observationWinner.text, punchlineWinner.text].join(SINGLE_SPACE);
  const composedLine: ComposedLine = {
    line: joinedLine,
    charCount: measureCharCount(joinedLine),
    openingText: openingWinner.text,
    observationText: observationWinner.text,
    punchlineText: punchlineWinner.text,
  };
  return composedLine;
}

/**
 * Gate the composed line exactly as the sealed scorer gates it, plus
 * two join-discipline checks of our own: no doubled space (a join
 * slip) and no leading or trailing space (a fragment edge slip).
 * UTF-8 text of 1 to 200 characters, not only white space, a single
 * line, and no trailing newline. Every failure is named in the reasons.
 */
function gateStatusLine(composed: ComposedLine): GateVerdict {
  const failureReasons: string[] = [];
  if (composed.charCount < GATE_MIN_CHARS) {
    failureReasons.push(`line is empty (minimum ${GATE_MIN_CHARS} character)`);
  }
  if (composed.charCount > GATE_MAX_CHARS) {
    failureReasons.push(`line is ${composed.charCount} characters (maximum ${GATE_MAX_CHARS})`);
  }
  if (composed.line.trim().length === 0) {
    failureReasons.push("line holds only white space");
  }
  if (composed.line.indexOf(NEWLINE_MARK) !== -1) {
    failureReasons.push("line spans more than one line");
  }
  if (composed.line.indexOf(CARRIAGE_MARK) !== -1) {
    failureReasons.push("line holds a carriage return");
  }
  if (composed.line.indexOf(DOUBLE_SPACE) !== -1) {
    failureReasons.push("line holds a doubled space");
  }
  if (composed.line.startsWith(SINGLE_SPACE)) {
    failureReasons.push("line starts with a space");
  }
  if (composed.line.endsWith(SINGLE_SPACE)) {
    failureReasons.push("line ends with a space");
  }
  const gateVerdict: GateVerdict = { valid: failureReasons.length === 0, reasons: failureReasons };
  return gateVerdict;
}

/**
 * Make sure the output directory exists before writing. The gate
 * output lives at an absolute path, so the directory is created
 * recursively when it is missing and left alone when it is present.
 */
function ensureOutputDirectory(outputPath: string): void {
  const outputDirectory = dirname(outputPath);
  if (existsSync(outputDirectory) === false) {
    mkdirSync(outputDirectory, { recursive: true });
  }
}

/**
 * Write the line with no trailing newline, then read the file back
 * and compare bytes, so a silent write failure can never pass as a
 * successful run. The comparison is byte for byte, not text to text.
 */
function writeStatusLine(outputPath: string, line: string): WriteOutcome {
  ensureOutputDirectory(outputPath);
  const lineBytes = Buffer.from(line, "utf8");
  writeFileSync(outputPath, lineBytes);
  const diskBytes = readFileSync(outputPath);
  const writeOutcome: WriteOutcome = {
    written: true,
    bytesWritten: lineBytes.length,
    readBackMatches: lineBytes.equals(diskBytes),
  };
  return writeOutcome;
}

/**
 * Run the whole entry: check catalogs, compose, gate, write, verify,
 * and report. A catalog or gate failure stops the run before any
 * write, and a read-back mismatch stops it with a nonzero exit code
 * after the write. The report names each winning fragment, so the
 * choice is auditable from the run log alone.
 */
function runWeeklyStatusReport(): number {
  const openingCatalogVerdict = checkCatalog(OPENING_CATALOG, "opening");
  const observationCatalogVerdict = checkCatalog(OBSERVATION_CATALOG, "observation");
  const punchlineCatalogVerdict = checkCatalog(PUNCHLINE_CATALOG, "punchline");
  const catalogsSound =
    openingCatalogVerdict.sound &&
    observationCatalogVerdict.sound &&
    punchlineCatalogVerdict.sound;
  if (catalogsSound === false) {
    console.error("catalog FAILED:");
    const allProblems = [
      ...openingCatalogVerdict.problems,
      ...observationCatalogVerdict.problems,
      ...punchlineCatalogVerdict.problems,
    ];
    for (const catalogProblem of allProblems) {
      console.error(`  - ${catalogProblem}`);
    }
    return 1;
  }
  const composed = composeStatusLine();
  const gateVerdict = gateStatusLine(composed);
  if (gateVerdict.valid === false) {
    console.error("gate FAILED:");
    for (const failureReason of gateVerdict.reasons) {
      console.error(`  - ${failureReason}`);
    }
    return 1;
  }
  const writeOutcome = writeStatusLine(OUTPUT_ENTRY_PATH, composed.line);
  if (writeOutcome.readBackMatches === false) {
    console.error("read-back FAILED: bytes on disk differ from the composed line");
    return 1;
  }
  console.log(`opening: ${composed.openingText}`);
  console.log(`observation: ${composed.observationText}`);
  console.log(`punchline: ${composed.punchlineText}`);
  console.log(`entry: ${composed.line}`);
  console.log(`chars: ${composed.charCount}`);
  console.log(`bytes: ${writeOutcome.bytesWritten}`);
  console.log(`sha256: ${hashComposedLine(composed.line)}`);
  console.log(`gate: VALID`);
  console.log(`read-back: MATCH`);
  return 0;
}

try { const exitCode = runWeeklyStatusReport(); process.exitCode = exitCode; } catch (caughtErr) { console.error("status report failed:", caughtErr); process.exitCode = 1; }
