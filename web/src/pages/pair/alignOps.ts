import type { AlignUnit } from "../../../../src/shared/schemas/alignment.ts";

/** Pure editing operations on alignment units. Units stay in book order on both sides. */

type Side = "source" | "target";
let counter = 0;
function newUnitId(): string {
  counter++;
  return `m${Date.now().toString(36)}${counter}`;
}

function clean(units: AlignUnit[]): AlignUnit[] {
  return units.filter((u) => u.source.length > 0 || u.target.length > 0);
}

function edited(u: AlignUnit): AlignUnit {
  return { ...u, confidence: null };
}

export function moveFirstToPrevious(units: AlignUnit[], index: number, side: Side): AlignUnit[] {
  if (index <= 0) return units;
  const unit = units[index]!;
  const first = unit[side][0];
  if (first === undefined) return units;
  const next = units.map((u) => ({ ...u }));
  next[index - 1] = edited({ ...next[index - 1]!, [side]: [...next[index - 1]![side], first] });
  next[index] = edited({ ...unit, [side]: unit[side].slice(1) });
  return clean(next);
}

export function moveLastToNext(units: AlignUnit[], index: number, side: Side): AlignUnit[] {
  const unit = units[index]!;
  const last = unit[side][unit[side].length - 1];
  if (last === undefined) return units;
  const next = units.map((u) => ({ ...u }));
  next[index] = edited({ ...unit, [side]: unit[side].slice(0, -1) });
  if (index + 1 < next.length) {
    next[index + 1] = edited({ ...next[index + 1]!, [side]: [last, ...next[index + 1]![side]] });
  } else {
    next.push({
      id: newUnitId(),
      source: side === "source" ? [last] : [],
      target: side === "target" ? [last] : [],
      include: false,
      confidence: null,
    });
  }
  return clean(next);
}

export function mergeWithNext(units: AlignUnit[], index: number): AlignUnit[] {
  if (index + 1 >= units.length) return units;
  const a = units[index]!;
  const b = units[index + 1]!;
  const merged = edited({
    ...a,
    source: [...a.source, ...b.source],
    target: [...a.target, ...b.target],
    include: a.include || b.include,
  });
  return [...units.slice(0, index), merged, ...units.slice(index + 2)];
}

/** Splits off the last segment of each side that has more than one into a new unit. */
export function splitLast(units: AlignUnit[], index: number): AlignUnit[] {
  const u = units[index]!;
  const takeSource = u.source.length > 1;
  const takeTarget = u.target.length > 1;
  if (!takeSource && !takeTarget) return units;
  const first = edited({
    ...u,
    source: takeSource ? u.source.slice(0, -1) : u.source,
    target: takeTarget ? u.target.slice(0, -1) : u.target,
  });
  const second: AlignUnit = {
    id: newUnitId(),
    source: takeSource ? u.source.slice(-1) : [],
    target: takeTarget ? u.target.slice(-1) : [],
    include: u.include,
    confidence: null,
  };
  return [...units.slice(0, index), first, second, ...units.slice(index + 1)];
}

/** Separates a unit into a source-only and a target-only unit. */
export function unlink(units: AlignUnit[], index: number): AlignUnit[] {
  const u = units[index]!;
  if (u.source.length === 0 || u.target.length === 0) return units;
  return [
    ...units.slice(0, index),
    { ...u, target: [], include: false, confidence: null },
    { id: newUnitId(), source: [], target: u.target, include: false, confidence: null },
    ...units.slice(index + 1),
  ];
}

export function setInclude(units: AlignUnit[], index: number, include: boolean): AlignUnit[] {
  return units.map((u, i) => (i === index ? { ...u, include } : u));
}
