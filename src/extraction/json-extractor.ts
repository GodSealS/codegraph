import { Node, Edge, ExtractionResult, ExtractionError, UnresolvedReference } from '../types';
import { generateNodeId } from './tree-sitter-helpers';

/**
 * JsonExtractor — lifts JSON config/data files into the graph as key nodes.
 *
 * A JSON file carries configuration, not code, so the useful graph unit is its
 * TOP-LEVEL keys (a `package.json`'s `scripts`, a `tsconfig.json`'s `compilerOptions`).
 * Each becomes a `constant` node whose name is the key. Values are NEVER stored —
 * a config value is routinely a secret (DB password, API key) and CodeGraph must
 * surface the KEY only, not read the value into agent context (#383). That is
 * enforced structurally here: the emitted node has no `docstring`/`signature`.
 *
 * Only a JSON object root yields keys; an array/scalar root just contributes the
 * file node. Invalid JSON degrades to the file node (never throws).
 */
export class JsonExtractor {
  private filePath: string;
  private source: string;
  private nodes: Node[] = [];
  private edges: Edge[] = [];
  private unresolvedReferences: UnresolvedReference[] = [];
  private errors: ExtractionError[] = [];
  private lineStarts: number[] = [];

  constructor(filePath: string, source: string) {
    this.filePath = filePath;
    this.source = source;
    this.lineStarts = [0];
    for (let i = 0; i < source.length; i++) {
      if (source.charCodeAt(i) === 10) this.lineStarts.push(i + 1);
    }
  }

  extract(): ExtractionResult {
    const startTime = Date.now();
    try {
      const fileNode = this.createFileNode();
      this.extractTopLevelKeys(fileNode.id);
    } catch (error) {
      this.errors.push({
        message: `JSON extraction error: ${error instanceof Error ? error.message : String(error)}`,
        severity: 'error',
        code: 'parse_error',
      });
    }
    return {
      nodes: this.nodes,
      edges: this.edges,
      unresolvedReferences: this.unresolvedReferences,
      errors: this.errors,
      durationMs: Date.now() - startTime,
    };
  }

  private lineAt(index: number): number {
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    let ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.lineStarts[mid]! <= index) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return ans + 1;
  }

  private colAt(index: number): number {
    return index - this.lineStarts[this.lineAt(index) - 1]!;
  }

  private createFileNode(): Node {
    const lines = this.source.split('\n');
    const node: Node = {
      id: generateNodeId(this.filePath, 'file', this.filePath, 1),
      kind: 'file',
      name: this.filePath.split(/[/\\]/).pop() || this.filePath,
      qualifiedName: this.filePath,
      filePath: this.filePath,
      language: 'json',
      startLine: 1,
      endLine: lines.length || 1,
      startColumn: 0,
      endColumn: lines[lines.length - 1]?.length ?? 0,
      updatedAt: Date.now(),
    };
    this.nodes.push(node);
    return node;
  }

  /** Top-level object keys → `constant` nodes (values never stored). */
  private extractTopLevelKeys(fileNodeId: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(this.source);
    } catch {
      return; // not valid JSON — the file node alone is enough
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;

    // Locate each key's `"key"` token by brace-depth scan — not by
    // `source.indexOf(JSON.stringify(key))`, which would land on an earlier
    // string value equal to another key (e.g. `{"a":"name","name":"x"}`).
    const offsets = this.findTopLevelKeyOffsets();
    for (const key of Object.keys(parsed as Record<string, unknown>)) {
      const needle = `${JSON.stringify(key)}`;
      const idx = offsets.get(key);
      const line = idx !== undefined ? this.lineAt(idx) : 1;
      const column = idx !== undefined ? this.colAt(idx) : 0;
      const node: Node = {
        id: generateNodeId(this.filePath, 'constant', key, line),
        kind: 'constant',
        name: key,
        qualifiedName: `${this.filePath}::${key}`,
        filePath: this.filePath,
        language: 'json',
        startLine: line,
        endLine: line,
        startColumn: column,
        endColumn: column + needle.length,
        updatedAt: Date.now(),
      };
      this.nodes.push(node);
      this.edges.push({ source: fileNodeId, target: node.id, kind: 'contains' });
    }
  }

  /**
   * Scan the raw source tracking `{}` depth and string literals, returning each
   * TOP-LEVEL object key's opening-quote offset (keyed by its decoded name). A
   * string at depth 1 followed by `:` is a key; a nested `"name":` (depth > 1)
   * or a string VALUE equal to another key never shadows the real one.
   */
  private findTopLevelKeyOffsets(): Map<string, number> {
    const offsets = new Map<string, number>();
    const src = this.source;
    let depth = 0;
    let i = 0;
    while (i < src.length) {
      const ch = src[i]!;
      if (ch === '"') {
        const start = i;
        i++; // opening quote
        while (i < src.length) {
          const c = src[i]!;
          if (c === '\\') {
            i += 2; // skip the escaped character
            continue;
          }
          if (c === '"') {
            i++; // closing quote
            break;
          }
          i++;
        }
        if (i > src.length) break; // unterminated string (invalid JSON, handled upstream)
        let j = i;
        while (j < src.length && (src[j] === ' ' || src[j] === '\t' || src[j] === '\n' || src[j] === '\r')) j++;
        if (src[j] === ':' && depth === 1) {
          try {
            const key = JSON.parse(src.slice(start, i)) as string;
            if (typeof key === 'string') offsets.set(key, start);
          } catch {
            // ignore — this string token is a value, not a key
          }
        }
        continue; // i already points past the closing quote
      }
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      i++;
    }
    return offsets;
  }
}
