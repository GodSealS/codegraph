import * as path from 'path';
import { Node, Edge, ExtractionResult, ExtractionError, UnresolvedReference } from '../types';
import { generateNodeId } from './tree-sitter-helpers';

/**
 * HtmlExtractor — gives plain `.html`/`.htm` files a graph presence.
 *
 * Static HTML is markup, not code, so there are no symbols to extract. What
 * matters for the graph is (a) that the file exists in the index, and (b) that
 * a local resource reference — `<a href="../page.html">`, `<link href="app.css">`,
 * `<script src="./main.js">`, `<img src="logo.png">` — is a dependency edge to
 * the referenced file. Those become `imports` references resolved by the
 * file-path matcher (the same mechanism PHP include / C `#include` use).
 *
 * HTML elements are lowercase so nothing is confused with a component (see the
 * Razor extractor, which only treats PascalCase tags as components). CDN/external
 * URLs, `#fragment` hrefs, and `data:`/`javascript:` URIs are skipped.
 */
export class HtmlExtractor {
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
      this.extractLocalResources(fileNode.id);
    } catch (error) {
      this.errors.push({
        message: `HTML extraction error: ${error instanceof Error ? error.message : String(error)}`,
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
      language: 'html',
      startLine: 1,
      endLine: lines.length || 1,
      startColumn: 0,
      endColumn: lines[lines.length - 1]?.length ?? 0,
      updatedAt: Date.now(),
    };
    this.nodes.push(node);
    return node;
  }

  /** `<a href>`/`<link href>` and `<script src>`/`<img src>` → local file refs. */
  private extractLocalResources(fileNodeId: string): void {
    // href-bearing elements (a, link) and src-bearing elements (script, img).
    // Each alternation captures its own quote group: href→\2, src→\5.
    // `(?<![\w-])` before href/src stops `data-href`/`data-src` (lazy-load
    // images, JS hooks) from shadowing the real `href`/`src` attribute.
    const attrRe = /<\s*(a|link)\b[^>]*?(?<![\w-])href\s*=\s*(["'])([^"']+)\2|<\s*(script|img)\b[^>]*?(?<![\w-])src\s*=\s*(["'])([^"']+)\5/gi;
    let m: RegExpExecArray | null;
    while ((m = attrRe.exec(this.source)) !== null) {
      const value = m[3] ?? m[6];
      if (!value) continue;
      const resolved = this.resolveLocalTarget(value);
      if (!resolved) continue;
      this.unresolvedReferences.push({
        fromNodeId: fileNodeId,
        referenceName: resolved,
        referenceKind: 'imports',
        line: this.lineAt(m.index),
        column: this.colAt(m.index),
        filePath: this.filePath,
        language: 'html',
      });
    }
  }

  private resolveLocalTarget(target: string): string | null {
    let t = target.trim();
    if (!t) return null;
    const hash = t.indexOf('#');
    if (hash >= 0) t = t.slice(0, hash);
    const query = t.indexOf('?');
    if (query >= 0) t = t.slice(0, query);
    t = t.trim();
    if (!t) return null;
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(t)) return null; // scheme or //host
    if (t.startsWith('/')) return null;
    const dir = path.posix.dirname(this.filePath.replace(/\\/g, '/'));
    const base = dir === '.' ? '' : dir;
    const normalized = path.posix.normalize(base ? path.posix.join(base, t) : t);
    if (normalized === '.' || normalized === '..') return null;
    return normalized;
  }
}
