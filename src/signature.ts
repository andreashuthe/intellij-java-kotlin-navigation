/**
 * Pure helpers (no `vscode` import) for matching method signatures across
 * a type hierarchy. Kept separate so they can be unit-tested with plain Node.
 */

/** Strip generics, array suffixes, varargs, annotations and package qualifiers: `java.util.List<String>[]` -> `List[]`. */
export function normalizeType(raw: string): string {
  let t = raw.trim();
  t = t.replace(/@[\w.]+(\([^)]*\))?\s*/g, ''); // annotations
  t = stripGenerics(t);
  t = t.replace(/\.\.\.$/, '[]'); // varargs == array
  t = t.replace(/\s+/g, '');
  t = t.replace(/\?$/, ''); // Kotlin nullable
  const arr = (t.match(/(\[\])+$/) ?? [''])[0];
  t = t.slice(0, t.length - arr.length);
  const simple = t.split('.').pop() ?? t;
  return simple + arr;
}

export function stripGenerics(s: string): string {
  let out = '';
  let depth = 0;
  for (const ch of s) {
    if (ch === '<') depth++;
    else if (ch === '>') depth = Math.max(0, depth - 1);
    else if (depth === 0) out += ch;
  }
  return out;
}

/** Split on commas that are not nested inside <>, (), []. */
export function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '<' || ch === '(' || ch === '[') depth++;
    if (ch === '>' || ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) parts.push(cur);
  return parts.map(p => p.trim()).filter(p => p.length > 0);
}

/**
 * Given source text starting at (or right before) the parameter list, return the
 * normalized parameter types, or `undefined` if no parameter list was found.
 * Handles Java (`final Type name`) and Kotlin (`name: Type = default`).
 */
export function parseParameterTypes(textFromName: string, language: string): string[] | undefined {
  const open = textFromName.indexOf('(');
  if (open < 0) return undefined;
  // Something other than whitespace/generics/name between name and '(' → not a param list we understand
  let depth = 0;
  let close = -1;
  for (let i = open; i < textFromName.length; i++) {
    const ch = textFromName[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close < 0) return undefined;
  const inner = textFromName.slice(open + 1, close).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  return splitTopLevel(inner).map(p => paramType(p, language));
}

function paramType(param: string, language: string): string {
  let p = param.replace(/@[\w.]+(\([^)]*\))?\s*/g, '').trim();
  if (language === 'kotlin') {
    p = p.replace(/^(vararg|noinline|crossinline)\s+/, '');
    const isVararg = /^vararg\s/.test(param.trim());
    const colon = p.indexOf(':');
    let type = colon >= 0 ? p.slice(colon + 1) : p;
    const eq = topLevelIndexOf(type, '=');
    if (eq >= 0) type = type.slice(0, eq);
    return normalizeType(type) + (isVararg ? '[]' : '');
  }
  p = p.replace(/^final\s+/, '');
  // Java: drop the trailing parameter name (and C-style array brackets after it)
  const m = p.match(/^(.*?)(\s+|(?<=[>\]]))([A-Za-z_$][\w$]*)\s*((?:\[\])*)$/s);
  if (m) return normalizeType(m[1] + m[4]);
  return normalizeType(p);
}

function topLevelIndexOf(s: string, needle: string): number {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '<' || ch === '(') depth++;
    else if (ch === '>' || ch === ')') depth--;
    else if (ch === needle && depth === 0) return i;
  }
  return -1;
}

/** Symbol names from some servers already contain the signature, e.g. `contains(Object) : boolean`. */
export function bareName(symbolName: string): string {
  const i = symbolName.indexOf('(');
  return (i >= 0 ? symbolName.slice(0, i) : symbolName).trim();
}

export function typesFromSymbolName(symbolName: string): string[] | undefined {
  if (!symbolName.includes('(')) return undefined;
  const inner = symbolName.slice(symbolName.indexOf('(') + 1, symbolName.lastIndexOf(')'));
  return splitTopLevel(inner).map(t => normalizeType(t));
}

export interface MethodSig {
  name: string;
  params?: string[];
}

/** Single-letter (or ALL_CAPS short) types are most likely type variables (T, E, K, V). */
function isTypeVar(t: string): boolean {
  return /^[A-Z][A-Z0-9]?(\[\])*$/.test(t);
}

/** Kotlin ↔ Java type names that denote the same JVM type (after normalizeType). */
const JVM_EQUIVALENT: Record<string, string> = {
  Any: 'Object',
  Unit: 'void',
  Int: 'int', Integer: 'int',
  Long: 'long',
  Short: 'short',
  Byte: 'byte',
  Double: 'double',
  Float: 'float',
  Boolean: 'boolean',
  Char: 'char', Character: 'char',
  IntArray: 'int[]', LongArray: 'long[]', ShortArray: 'short[]', ByteArray: 'byte[]',
  DoubleArray: 'double[]', FloatArray: 'float[]', BooleanArray: 'boolean[]', CharArray: 'char[]',
  CharSequence: 'CharSequence',
};

/** Canonical JVM-ish name so a Kotlin override matches its Java super method (and vice versa). */
export function jvmType(t: string): string {
  let x = t.replace(/^Mutable(?=[A-Z])/, ''); // MutableList → List
  if (x === 'Array') return '[]'; // Array<T> lost its element type in normalizeType
  if (JVM_EQUIVALENT[x]) x = JVM_EQUIVALENT[x];
  // boxed Java types (Long, Short, …) collapse onto their primitive above via the Kotlin names
  return x;
}

function sameJvmType(a: string, b: string): boolean {
  const x = jvmType(a);
  const y = jvmType(b);
  if (x === y) return true;
  // Kotlin Array<T> vs Java T[]
  return (x === '[]' && y.endsWith('[]')) || (y === '[]' && x.endsWith('[]'));
}

export function paramsCompatible(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((t, i) => t === b[i] || isTypeVar(t) || isTypeVar(b[i]) || sameJvmType(t, b[i]));
}

/**
 * Pick the method in `candidates` that `sub` overrides/implements.
 * Exact (or generic-compatible) parameter match wins; otherwise a unique name+arity match.
 */
export function findMatchingMethod<T extends MethodSig>(sub: MethodSig, candidates: T[]): T | undefined {
  const byName = candidates.filter(c => c.name === sub.name);
  if (byName.length === 0) return undefined;
  if (!sub.params) return byName.length === 1 ? byName[0] : undefined;
  const exact = byName.find(c => c.params && c.params.length === sub.params!.length && c.params.every((t, i) => t === sub.params![i]));
  if (exact) return exact;
  const compatible = byName.filter(c => c.params && paramsCompatible(c.params, sub.params!));
  if (compatible.length >= 1) return compatible[0];
  const sameArity = byName.filter(c => !c.params || c.params.length === sub.params!.length);
  return sameArity.length === 1 && !sameArity[0].params ? sameArity[0] : undefined;
}

/** Blank out generic arguments and parenthesised parts with spaces, keeping offsets intact. */
function maskNested(s: string): string {
  let masked = '';
  let depth = 0;
  for (const ch of s) {
    if (ch === '<' || ch === '(') depth++;
    const keep = depth === 0;
    if (ch === '>' || ch === ')') depth = Math.max(0, depth - 1);
    masked += keep ? ch : ' ';
  }
  return masked;
}

/** Parse `extends A, B implements C<D>` / Kotlin `: A(), B` header text into simple type names with offsets. */
export function parseSupertypeRefs(header: string, language: string): { name: string; offset: number }[] {
  const refs: { name: string; offset: number }[] = [];
  let clause: string | undefined;
  let base = 0;
  if (language === 'kotlin') {
    // header is from the class keyword up to '{' (or end). Find ':' at top level after the primary constructor.
    let depth = 0;
    for (let i = 0; i < header.length; i++) {
      const ch = header[i];
      if (ch === '(' || ch === '<') depth++;
      else if (ch === ')' || ch === '>') depth--;
      else if (ch === ':' && depth === 0) {
        base = i + 1;
        clause = header.slice(base);
        break;
      }
    }
    if (clause) clause = clause.replace(/\bwhere\b[\s\S]*$/, '');
  } else {
    // Ignore the class's own type parameters (`class Foo<T extends Number> extends Bar`)
    const m = maskNested(header).match(/\b(extends|implements|permits)\b/);
    if (m && m.index !== undefined) {
      base = m.index;
      clause = header.slice(base).replace(/\bpermits\b[\s\S]*$/, '');
    }
  }
  if (!clause) return refs;
  const masked = maskNested(clause);
  const re = /([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)/g;
  let mm: RegExpExecArray | null;
  while ((mm = re.exec(masked))) {
    const word = mm[1];
    if (['extends', 'implements', 'by'].includes(word)) continue;
    // `by delegate` in Kotlin: skip the identifier following `by`
    const before = masked.slice(0, mm.index).trimEnd();
    if (/\bby$/.test(before)) continue;
    const lastDot = word.lastIndexOf('.');
    const simple = lastDot >= 0 ? word.slice(lastDot + 1).trim() : word;
    const offsetInWord = lastDot >= 0 ? word.length - simple.length : 0;
    refs.push({ name: simple, offset: base + mm.index + offsetInWord });
  }
  return refs;
}
