import { describe, it, expect } from 'vitest';
import { extractFromSource } from '../src/extraction/tree-sitter';

// The Markdown / HTML / JSON extractors are wired through extractFromSource,
// which resolves the language from the file extension (grammars.ts EXTENSION_MAP)
// and dispatches to the matching custom extractor. These tests exercise that
// whole path.

const byKind = (result: ReturnType<typeof extractFromSource>, kind: string) =>
  result.nodes.filter((n) => n.kind === kind);

describe('Markdown extractor', () => {
  it('emits a file node', () => {
    const fileNodes = byKind(extractFromSource('docs/guide.md', '# Hi'), 'file');
    expect(fileNodes).toHaveLength(1);
    expect(fileNodes[0]!.language).toBe('markdown');
    expect(fileNodes[0]!.qualifiedName).toBe('docs/guide.md');
  });

  it('extracts ATX headings as namespace nodes', () => {
    const names = byKind(extractFromSource('docs/guide.md', '# Intro\n## Setup\n### Deep'), 'namespace').map(
      (n) => n.name
    );
    expect(names).toEqual(['Intro', 'Setup', 'Deep']);
  });

  it('strips inline formatting from heading names', () => {
    const md = '# **Bold** and `code` and [a link](x.md)';
    expect(byKind(extractFromSource('a.md', md), 'namespace').map((n) => n.name)).toEqual([
      'Bold and code and a link',
    ]);
  });

  it('does not treat `#` inside a fenced code block as a heading', () => {
    const md = '```python\n# not a heading\ndef f():\n    pass\n```\n# Real heading';
    expect(byKind(extractFromSource('a.md', md), 'namespace').map((n) => n.name)).toEqual(['Real heading']);
  });

  it('resolves relative links to repo-relative paths', () => {
    const refs = extractFromSource(
      'docs/guide.md',
      '[api](./api.md) and [home](../README.md)'
    ).unresolvedReferences.map((r) => r.referenceName);
    expect(refs).toEqual(['docs/api.md', 'README.md']);
  });

  it('emits links as imports references anchored to the file node', () => {
    const result = extractFromSource('docs/guide.md', '[api](./api.md)');
    const fileNode = byKind(result, 'file')[0]!;
    expect(result.unresolvedReferences).toHaveLength(1);
    expect(result.unresolvedReferences[0]!.referenceKind).toBe('imports');
    expect(result.unresolvedReferences[0]!.fromNodeId).toBe(fileNode.id);
    expect(result.unresolvedReferences[0]!.language).toBe('markdown');
  });

  it('skips images, external URLs, anchors, and absolute paths', () => {
    const md = [
      '![pic](img.png)',
      '[ext](https://example.com/x.md)',
      '[proto](//cdn.example.com/x.md)',
      '[mail](mailto:a@b.c)',
      '[anchor](#section)',
      '[abs](/abs.md)',
      '[data](data:text/plain,hi)',
    ].join('\n');
    expect(extractFromSource('a.md', md).unresolvedReferences).toHaveLength(0);
  });

  it('does not extract links inside fenced code blocks', () => {
    const md = '```\n[not a link](./nope.md)\n```\n[real](./yes.md)';
    expect(extractFromSource('a.md', md).unresolvedReferences.map((r) => r.referenceName)).toEqual(['yes.md']);
  });
});

describe('HTML extractor', () => {
  it('emits a file node', () => {
    const fileNodes = byKind(extractFromSource('site/index.html', '<html></html>'), 'file');
    expect(fileNodes).toHaveLength(1);
    expect(fileNodes[0]!.language).toBe('html');
  });

  it('extracts local href/src as imports references', () => {
    const html =
      '<a href="about.html">about</a>' +
      '<link href="app.css" rel="stylesheet">' +
      '<script src="./main.js"></script>' +
      '<img src="logo.png">';
    const refs = extractFromSource('site/index.html', html).unresolvedReferences.map(
      (r) => r.referenceName
    );
    expect(refs).toEqual(['site/about.html', 'site/app.css', 'site/main.js', 'site/logo.png']);
  });

  it('prefers the real href/src over a data-href/data-src attribute', () => {
    const html =
      '<a data-href="foo.html" href="bar.html">x</a>' +
      '<img data-src="real.jpg" src="placeholder.jpg">';
    const refs = extractFromSource('site/index.html', html).unresolvedReferences.map(
      (r) => r.referenceName
    );
    expect(refs).toEqual(['site/bar.html', 'site/placeholder.jpg']);
  });

  it('skips external and fragment-only URIs', () => {
    const html =
      '<script src="https://cdn.example.com/lib.js"></script>' +
      '<a href="#top">top</a>' +
      '<a href="javascript:void(0)">x</a>';
    expect(extractFromSource('index.html', html).unresolvedReferences).toHaveLength(0);
  });
});

describe('JSON extractor', () => {
  it('emits a file node', () => {
    const fileNodes = byKind(extractFromSource('package.json', '{}'), 'file');
    expect(fileNodes).toHaveLength(1);
    expect(fileNodes[0]!.language).toBe('json');
  });

  it('extracts only top-level keys as constant nodes', () => {
    const json = '{"name":"app","scripts":{"test":"vitest"},"version":"1.0.0"}';
    const names = byKind(extractFromSource('package.json', json), 'constant').map((n) => n.name);
    expect(names).toEqual(['name', 'scripts', 'version']);
  });

  it('locates a key by brace depth, not by first string match', () => {
    // `"a"`'s value equals the later key name — a naive indexOf(key) would
    // anchor the `name` node at the value (column 5) instead of the real key.
    const json = '{"a":"name","name":"x"}';
    const nameNode = byKind(extractFromSource('x.json', json), 'constant').find((n) => n.name === 'name')!;
    expect(nameNode).toBeDefined();
    expect(nameNode.startColumn).toBe(json.indexOf('"name":'));
  });

  it('never stores values (secret safety, #383)', () => {
    const json = '{"apiKey":"super-secret-value"}';
    const node = byKind(extractFromSource('config.json', json), 'constant')[0]!;
    expect(node.docstring).toBeUndefined();
    expect(node.signature).toBeUndefined();
    expect(node.name).toBe('apiKey');
  });

  it('degrades to a file node for non-object or invalid JSON', () => {
    for (const src of ['[]', '"just a string"', '{not valid json']) {
      const result = extractFromSource('x.json', src);
      expect(byKind(result, 'constant')).toHaveLength(0);
      expect(byKind(result, 'file')).toHaveLength(1);
    }
  });
});
