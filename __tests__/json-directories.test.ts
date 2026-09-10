import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';
import { loadJsonDirectories, clearProjectConfigCache } from '../src/project-config';

// `codegraph.json` `jsonDirectories` — the opt-in directory whitelist for `.json`
// files. `.json` is NOT a source file by default; only files under an explicitly
// listed directory enter the index.

describe('codegraph.json jsonDirectories', () => {
  describe('loadJsonDirectories', () => {
    let dir: string;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-jsondir-'));
      clearProjectConfigCache();
    });
    afterEach(() => {
      clearProjectConfigCache();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const writeConfig = (obj: unknown) =>
      fs.writeFileSync(
        path.join(dir, 'codegraph.json'),
        typeof obj === 'string' ? obj : JSON.stringify(obj)
      );

    it('returns empty when there is no codegraph.json', () => {
      expect(loadJsonDirectories(dir)).toEqual([]);
    });

    it('loads a well-formed jsonDirectories array', () => {
      writeConfig({ jsonDirectories: ['config', 'src/data/'] });
      expect(loadJsonDirectories(dir)).toEqual(['config', 'src/data/']);
    });

    it('skips a non-array value and non-string/blank entries', () => {
      writeConfig({ jsonDirectories: 'config' });
      expect(loadJsonDirectories(dir)).toEqual([]);

      writeConfig({ jsonDirectories: ['config', 42, ''] });
      expect(loadJsonDirectories(dir)).toEqual(['config']);
    });
  });

  describe('indexAll honors jsonDirectories end-to-end', () => {
    let dir: string;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-jsondir-idx-'));
      clearProjectConfigCache();
    });
    afterEach(() => {
      clearProjectConfigCache();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const write = (rel: string, body: string) => {
      const p = path.join(dir, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, body);
    };

    it('indexes only .json under whitelisted directories', async () => {
      write('codegraph.json', JSON.stringify({ jsonDirectories: ['config'] }));
      write('config/app.json', '{"name":"app"}');
      write('package.json', '{"name":"root"}');
      write('README.md', '# Hi\n');
      write('src/index.ts', 'export const x = 1;\n');

      const cg = await CodeGraph.init(dir, { silent: true });
      await cg.indexAll();
      const db = (cg as any).db.db;
      const files = db.prepare('SELECT path, language FROM files ORDER BY path').all();
      cg.close?.();

      const paths = files.map((f: { path: string }) => f.path);
      // Whitelisted `.json` enters, under the `json` language.
      expect(paths).toContain('config/app.json');
      expect(files.find((f: { path: string }) => f.path === 'config/app.json')!.language).toBe('json');
      // `.json` outside the whitelist does NOT enter.
      expect(paths).not.toContain('package.json');
      // `.md` / code are unaffected.
      expect(paths).toContain('README.md');
      expect(paths).toContain('src/index.ts');
    });
  });
});
