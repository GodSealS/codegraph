/**
 * CodeBuddy target.
 *
 *   - Global MCP entry written to `~/.codebuddy/.mcp.json`
 *     (CodeBuddy-specific user-level MCP config path).
 *   - Project-local MCP entry written to `./.mcp.json`
 *     (the shared standard MCP config file, also used by Claude Code).
 *   - No agent instructions file (CodeBuddy IDE/CLI do not use
 *     a CLAUDE.md / AGENTS.md style instruction file, so we skip it).
 *   - No permissions concept — CodeBuddy doesn't have an auto-allow list
 *     the installer can populate. `autoAllow` and `promptHook` are
 *     silently ignored.
 *
 * ## Config path rationale
 *
 * CodeBuddy recommends distinct paths for each scope:
 *
 *   - global  → `~/.codebuddy/.mcp.json` (the `.mcp.json` IN the
 *               `.codebuddy` config directory)
 *   - project → `<project-root>/.mcp.json` (standard at-root MCP file)
 *
 * See https://www.codebuddy.ai/docs/cli/mcp for the full documentation.
 * The old `~/.codebuddy/mcp.json` (no leading dot) is deprecated and we
 * do not write to it, but `detect` checks both so we correctly report
 * alreadyConfigured=true even when the entry lives in the old path.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  AgentTarget,
  DetectionResult,
  InstallOptions,
  Location,
  WriteResult,
} from './types';
import {
  getMcpServerConfig,
  jsonDeepEqual,
  readJsonFile,
  writeJsonFile,
} from './shared';

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Deprecated user global path that earlier versions may have written to. */
const LEGACY_USER_MCP = path.join(os.homedir(), '.codebuddy', 'mcp.json');

function userMcpDir(): string {
  return path.join(os.homedir(), '.codebuddy');
}

function mcpJsonPath(loc: Location): string {
  return loc === 'global'
    ? path.join(userMcpDir(), '.mcp.json')
    : path.join(process.cwd(), '.mcp.json');
}

// ---------------------------------------------------------------------------
// MCP write helpers
// ---------------------------------------------------------------------------

function writeMcpEntry(loc: Location): WriteResult['files'][number] {
  const file = mcpJsonPath(loc);
  const existing = readJsonFile(file);
  const before = existing.mcpServers?.codegraph;
  const after = getMcpServerConfig();

  if (jsonDeepEqual(before, after)) {
    return { path: file, action: 'unchanged' };
  }
  const action: 'created' | 'updated' = before
    ? 'updated'
    : fs.existsSync(file)
      ? 'updated'
      : 'created';
  if (!existing.mcpServers) existing.mcpServers = {};
  existing.mcpServers.codegraph = after;
  writeJsonFile(file, existing);
  return { path: file, action };
}

/**
 * Sweep the deprecated legacy user MCP path. If the codegraph entry
 * exists there but the primary path is clean (or codegraph-less), we
 * migrate: write the entry to the canonical location and strip the
 * legacy entry. Returns one or more WriteResult entries.
 */
function sweepLegacyMcpPath(): WriteResult['files'][number][] {
  const results: WriteResult['files'][number][] = [];
  const canonical = mcpJsonPath('global');

  if (!fs.existsSync(LEGACY_USER_MCP)) return results;

  const legacyCfg = readJsonFile(LEGACY_USER_MCP);
  if (!legacyCfg.mcpServers?.codegraph) return results;

  // Migration needed: ensure canonical path has the entry.
  const canonicalCfg = readJsonFile(canonical);
  if (!canonicalCfg.mcpServers?.codegraph) {
    if (!canonicalCfg.mcpServers) canonicalCfg.mcpServers = {};
    canonicalCfg.mcpServers.codegraph = getMcpServerConfig();
    writeJsonFile(canonical, canonicalCfg);
    results.push({ path: canonical, action: 'updated' });
  }

  // Strip codegraph from the legacy file; preserve sibling servers.
  delete legacyCfg.mcpServers.codegraph;
  if (Object.keys(legacyCfg.mcpServers).length === 0) {
    delete legacyCfg.mcpServers;
  }
  writeJsonFile(LEGACY_USER_MCP, legacyCfg);
  results.push({ path: LEGACY_USER_MCP, action: 'removed' });

  return results;
}

/**
 * Remove codegraph entry from the deprecated legacy path too, in
 * case a previous version wrote there. Only removes the entry — never
 * touches sibling servers.
 */
function uninstallLegacyMcpPath(): WriteResult['files'][number] | null {
  if (!fs.existsSync(LEGACY_USER_MCP)) return null;

  const legacyCfg = readJsonFile(LEGACY_USER_MCP);
  if (!legacyCfg.mcpServers?.codegraph) return null;

  delete legacyCfg.mcpServers.codegraph;
  if (Object.keys(legacyCfg.mcpServers).length === 0) {
    delete legacyCfg.mcpServers;
  }
  writeJsonFile(LEGACY_USER_MCP, legacyCfg);
  return { path: LEGACY_USER_MCP, action: 'removed' };
}

// ---------------------------------------------------------------------------
// Target class
// ---------------------------------------------------------------------------

class CodeBuddyTarget implements AgentTarget {
  readonly id = 'codebuddy' as const;
  readonly displayName = 'CodeBuddy';
  readonly docsUrl = 'https://www.codebuddy.ai/docs/ide/User-guide/MCP';

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const mcpPath = mcpJsonPath(loc);
    const config = readJsonFile(mcpPath);
    let alreadyConfigured = !!config.mcpServers?.codegraph;

    // Also probe the deprecated legacy path for global detection.
    let installed = loc === 'global'
      ? fs.existsSync(path.join(os.homedir(), '.codebuddy'))
      : fs.existsSync(path.join(process.cwd(), '.mcp.json'));

    if (!alreadyConfigured && loc === 'global') {
      const legacyCfg = readJsonFile(LEGACY_USER_MCP);
      alreadyConfigured = !!legacyCfg.mcpServers?.codegraph;
    }

    return { installed, alreadyConfigured, configPath: mcpPath };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    const files: WriteResult['files'] = [];

    files.push(writeMcpEntry(loc));

    // Self-heal: migrate legacy path entry on global install.
    if (loc === 'global') {
      files.push(...sweepLegacyMcpPath());
    }

    return {
      files,
      notes: ['Restart CodeBuddy for MCP changes to take effect.'],
    };
  }

  uninstall(loc: Location): WriteResult {
    const files: WriteResult['files'] = [];

    const mcpPath = mcpJsonPath(loc);
    const config = readJsonFile(mcpPath);
    if (config.mcpServers?.codegraph) {
      delete config.mcpServers.codegraph;
      if (Object.keys(config.mcpServers).length === 0) {
        delete config.mcpServers;
      }
      writeJsonFile(mcpPath, config);
      files.push({ path: mcpPath, action: 'removed' });
    } else {
      files.push({ path: mcpPath, action: 'not-found' });
    }

    // Sweep the legacy user path on global uninstall.
    if (loc === 'global') {
      const legacy = uninstallLegacyMcpPath();
      if (legacy) files.push(legacy);
    }

    return { files };
  }

  printConfig(loc: Location): string {
    const target = mcpJsonPath(loc);
    const snippet = JSON.stringify(
      { mcpServers: { codegraph: getMcpServerConfig() } },
      null,
      2,
    );
    return `# Add to ${target}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    const paths = [mcpJsonPath(loc)];
    // Include the legacy path in describePaths for global so the
    // readme / --print-config surfaces everything.
    if (loc === 'global') {
      // Only include if the legacy file exists (it's the one that needs
      // manual cleanup).
      if (fs.existsSync(LEGACY_USER_MCP)) {
        paths.push(LEGACY_USER_MCP);
      }
    }
    return paths;
  }
}

export const codebuddyTarget: AgentTarget = new CodeBuddyTarget();
