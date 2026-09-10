import * as path from 'path';
import { Node, Edge, ExtractionResult, ExtractionError, UnresolvedReference } from '../types';
import { generateNodeId } from './tree-sitter-helpers';

/**
 * MarkdownExtractor — lifts Markdown docs into the graph.
 *
 * CodeGraph is a symbol graph, but a project's docs name the very symbols it
 * indexes (a `docs/api.md` linking `../src/foo.ts` is the doc→code edge). This
 * extractor gives `.md` files a graph presence without a tree-sitter grammar:
 *
 *  - One `file` node (so the watcher/sync track the doc and it's file-listable).
 *  - One `namespace` node per ATX heading (`#`..`######`) — the heading text is
 *    the searchable name; FTS indexes it so `codegraph_search` can find a doc
 *    by section title.
 *  - Each `[text](target)` link becomes an `imports` reference resolved by the
 *    file-path matcher to the target file's `file` node (doc→doc and doc→code
 *    edges). `imports` (not `references`) is deliberate: markdown is NOT a
 *    known language family, so the `references` cross-family gate would drop a
 *    link to a `.ts`/`.html` file, while `imports` only gates *both-known*
 *    families (name-matcher.ts `crossesKnownFamily`).
 *
 * Deliberately out of scope (noise / low value): identifiers inside fenced code
 * blocks, reference-style links (`[a][id]`), HTML `<a>` in inline Markdown.
 */
export class MarkdownExtractor {
  private filePath: string;
  private source: string;
  private nodes: Node[] = [];
  private edges: Edge[] = [];
  private unresolvedReferences: UnresolvedReference[] = [];
  private errors: ExtractionError[] = [];
  private lineStarts: number[] = [];

  constructor(filePath: string, source: string) {
    this.filePath = filePath;
    // Mask fenced code blocks (```/~~~) so a `# comment` inside a code sample
    // isn't mistaken for a heading and a `[x](y)` in code isn't a link. Length-
    // preserving (newlines kept) so offsets/line numbers still map to source.
    this.source = MarkdownExtractor.maskFencedCode(source);
    this.lineStarts = [0];
    for (let i = 0; i < this.source.length; i++) {
      if (this.source.charCodeAt(i) === 10) this.lineStarts.push(i + 1);
    }
  }

  extract(): ExtractionResult {
    const startTime = Date.now();
    try {
      const fileNode = this.createFileNode();
      this.extractHeadings(fileNode.id);
      this.extractLinks(fileNode.id);
    } catch (error) {
      this.errors.push({
        message: `Markdown extraction error: ${error instanceof Error ? error.message : String(error)}`,
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

  /** 1-based line for a character index (binary search over newline offsets). */
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
      language: 'markdown',
      startLine: 1,
      endLine: lines.length || 1,
      startColumn: 0,
      endColumn: lines[lines.length - 1]?.length ?? 0,
      updatedAt: Date.now(),
    };
    this.nodes.push(node);
    return node;
  }

  /** ATX headings (`#`..`######`) → one `namespace` node each. */
  private extractHeadings(fileNodeId: string): void {
    const headingRe = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/gm;
    let m: RegExpExecArray | null;
    while ((m = headingRe.exec(this.source)) !== null) {
      const title = this.cleanInline(m[2]!.trim());
      if (!title) continue;
      const line = this.lineAt(m.index);
      const node: Node = {
        id: generateNodeId(this.filePath, 'namespace', title, line),
        kind: 'namespace',
        name: title,
        qualifiedName: `${this.filePath}::${title}`,
        filePath: this.filePath,
        language: 'markdown',
        startLine: line,
        endLine: line,
        startColumn: this.colAt(m.index),
        endColumn: this.colAt(m.index) + m[0].length,
        updatedAt: Date.now(),
      };
      this.nodes.push(node);
      this.edges.push({ source: fileNodeId, target: node.id, kind: 'contains' });
    }
  }

  /** `[text](target)` → `imports` reference to the target file's file node. */
  private extractLinks(fileNodeId: string): void {
    const linkRe = /(!?)\[([^\]]*)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
    let m: RegExpExecArray | null;
    while ((m = linkRe.exec(this.source)) !== null) {
      if (m[1] === '!') continue; // ![image](...) — not a doc/code reference
      const resolved = this.resolveLocalTarget(m[3]!);
      if (!resolved) continue;
      this.unresolvedReferences.push({
        fromNodeId: fileNodeId,
        referenceName: resolved,
        referenceKind: 'imports',
        line: this.lineAt(m.index),
        column: this.colAt(m.index),
        filePath: this.filePath,
        language: 'markdown',
      });
    }
  }

  /**
   * Resolve a link target to a repo-relative POSIX path, or null when it's not
   * a local file reference (URLs, protocol-relative, `#anchors`, absolute paths,
   * empty). Mirrors how the file-path matcher keys off repo-relative paths.
   */
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
    if (t.startsWith('/')) return null; // absolute — can't map to repo-relative
    const dir = path.posix.dirname(this.filePath.replace(/\\/g, '/'));
    const base = dir === '.' ? '' : dir;
    const normalized = path.posix.normalize(base ? path.posix.join(base, t) : t);
    if (normalized === '.' || normalized === '..') return null;
    return normalized;
  }

  /** Strip inline Markdown formatting so a heading's name is plain text. */
  private cleanInline(text: string): string {
    return text
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // images
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links → text
      .replace(/`([^`]*)`/g, '$1')
      .replace(/(\*\*|__)(.*?)\1/g, '$2')
      .replace(/(\*|_)(.*?)\1/g, '$2')
      .replace(/<[^>]+>/g, '')
      .trim();
  }

  /** Blank out fenced code blocks (``` or ~~~), keeping newlines/offsets intact. */
  private static maskFencedCode(src: string): string {
    const out = src.split('');
    const n = src.length;
    let i = 0;
    while (i < n) {
      const fence = src[i] === '`' && src[i + 1] === '`' && src[i + 2] === '`' ? '```'
        : src[i] === '~' && src[i + 1] === '~' && src[i + 2] === '~' ? '~~~'
        : null;
      if (fence) {
        const end = src.indexOf(fence, i + 3);
        const stop = end >= 0 ? end + 3 : n;
        for (let j = i; j < stop; j++) if (src.charCodeAt(j) !== 10) out[j] = ' ';
        i = stop;
        continue;
      }
      i++;
    }
    return out.join('');
  }
}
