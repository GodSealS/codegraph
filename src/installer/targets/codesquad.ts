/**
 * CodeSquad target.
 *
 * CodeSquad is an agent orchestration platform that runs on top of
 * CodeBuddy Code. It shares the same MCP configuration paths:
 *
 *   - Global MCP entry written to `~/.codebuddy/.mcp.json`
 *     (CodeBuddy/CodeSquad user-level MCP config path).
 *   - Project-local MCP entry written to `./.mcp.json`
 *     (shared standard MCP config file, also used by Claude Code).
 *
 * In addition to the standard `.mcp.json`, CodeSquad also reads from
 * `.codebuddy/settings.json` (project-local) and supports the
 * `enableAllProjectMcpServers` setting which auto-discovers MCP servers
 * defined in the project's `.mcp.json`. We write this flag so CodeSquad
 * automatically picks up the codegraph MCP server from `.mcp.json`.
 *
 * ## Config path rationale
 *
 * CodeSquad delegates MCP to CodeBuddy Code, so:
 *
 *   - global  → `~/.codebuddy/.mcp.json` (same as CodeBuddy)
 *   - project → `<project-root>/.mcp.json` (same as CodeBuddy/Claude)
 *   - Also writes `enableAllProjectMcpServers: true` to
 *     `.codebuddy/settings.json` so CodeSquad autodetects it.
 *
 * Detection checks for `~/.codesquad/` as the CodeSquad-specific marker.
 *
 * ## Shared-file tracking
 *
 * Because CodeSquad and CodeBuddy write to the same `.mcp.json`, a
 * full-target uninstall sweep (codebuddy then codesquad) would leave
 * codesquad with nothing to remove — codebuddy already cleaned the
 * shared entry. To give uninstallTargets a reliable "removed" report,
 * we maintain a small install marker file:
 *
 *   - global:  `~/.codesquad/.codegraph-marker`
 *   - local:   `<project>/.codebuddy/.codesquad-marker`
 *
 * This marker is created on install and removed on uninstall, giving
 * codesquad always-own file that proves it was installed regardless
 * of whether the shared MCP entry was already cleaned by codebuddy.
 *
 * No permissions concept — CodeSquad doesn't have an auto-allow list.
 * `autoAllow` and `promptHook` are silently ignored.
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
  atomicWriteFileSync,
} from './shared';

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** CodeSquad-specific user config directory. */
function codesquadHomeDir(): string {
  return path.join(os.homedir(), '.codesquad');
}

/** Shared CodeBuddy user MCP config directory. */
function codebuddyUserDir(): string {
  return path.join(os.homedir(), '.codebuddy');
}

function mcpJsonPath(loc: Location): string {
  return loc === 'global'
    ? path.join(codebuddyUserDir(), '.mcp.json')
    : path.join(process.cwd(), '.mcp.json');
}

/**
 * Project-local `.codebuddy/settings.json` — CodeSquad reads this for
 * MCP-related settings like `enableAllProjectMcpServers`.
 */
function codebuddySettingsPath(): string {
  return path.join(process.cwd(), '.codebuddy', 'settings.json');
}

/**
 * Install marker file — unique to CodeSquad so uninstallTargets can
 * always find at least one CodeSquad-specific file to remove.
 */
function installMarkerPath(loc: Location): string {
  return loc === 'global'
    ? path.join(codesquadHomeDir(), '.codegraph-marker')
    : path.join(process.cwd(), '.codebuddy', '.codesquad-marker');
}

// ---------------------------------------------------------------------------
// Shared MCP write helpers
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
 * Enable `enableAllProjectMcpServers: true` in `.codebuddy/settings.json`
 * so CodeSquad automatically picks up MCP servers defined in the project's
 * `.mcp.json`. Only meaningful for local install.
 */
function writeEnableProjectMcpServers(): WriteResult['files'][number] {
  const file = codebuddySettingsPath();
  const existing = readJsonFile(file);

  // Only write if the flag isn't already set to true.
  if (existing.enableAllProjectMcpServers === true) {
    return { path: file, action: 'unchanged' };
  }

  // Ensure the dir exists.
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Read again for atomicity (readJsonFile above may have created the file).
  const current = readJsonFile(file);
  current.enableAllProjectMcpServers = true;
  writeJsonFile(file, current);

  const fileExisted = fs.existsSync(file);
  const action: 'created' | 'updated' = fileExisted ? 'updated' : 'created';
  return { path: file, action };
}

/**
 * Remove the `enableAllProjectMcpServers` setting from `settings.json`.
 * Only strips the flag if it was `true`. Preserves all other settings.
 */
function removeEnableProjectMcpServers(): WriteResult['files'][number] {
  const file = codebuddySettingsPath();
  if (!fs.existsSync(file)) {
    return { path: file, action: 'not-found' };
  }

  const config = readJsonFile(file);
  if (config.enableAllProjectMcpServers !== true) {
    return { path: file, action: 'not-found' };
  }

  delete config.enableAllProjectMcpServers;
  writeJsonFile(file, config);
  return { path: file, action: 'removed' };
}

// ---------------------------------------------------------------------------
// Install marker helpers
// ---------------------------------------------------------------------------

/**
 * Create the CodeSquad-specific install marker file. Returns a WriteResult
 * entry describing the action taken.
 */
function writeInstallMarker(loc: Location): WriteResult['files'][number] {
  const file = installMarkerPath(loc);
  if (fs.existsSync(file)) {
    return { path: file, action: 'unchanged' };
  }
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  atomicWriteFileSync(file, '');
  return { path: file, action: 'created' };
}

/**
 * Remove the CodeSquad-specific install marker. Returns a WriteResult
 * describing what happened.
 */
function removeInstallMarker(loc: Location): WriteResult['files'][number] {
  const file = installMarkerPath(loc);
  if (!fs.existsSync(file)) {
    return { path: file, action: 'not-found' };
  }
  try {
    fs.unlinkSync(file);
  } catch {
    return { path: file, action: 'not-found' };
  }
  return { path: file, action: 'removed' };
}

// ---------------------------------------------------------------------------
// Target class
// ---------------------------------------------------------------------------

class CodeSquadTarget implements AgentTarget {
  readonly id = 'codesquad' as const;
  readonly displayName = 'CodeSquad';
  readonly docsUrl = 'https://github.com/user-attachments/files/CodeSquad';

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const mcpPath = mcpJsonPath(loc);
    const config = readJsonFile(mcpPath);
    const alreadyConfigured = !!config.mcpServers?.codegraph;

    // CodeSquad-specific "installed" heuristic: check for ~/.codesquad/
    // (CodeSquad's own config directory).
    const installed = loc === 'global'
      ? fs.existsSync(codesquadHomeDir())
      : fs.existsSync(path.join(process.cwd(), '.codebuddy'));

    return { installed, alreadyConfigured, configPath: mcpPath };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    const files: WriteResult['files'] = [];

    // 1. Write MCP server entry into .mcp.json (shared with CodeBuddy).
    files.push(writeMcpEntry(loc));

    // 2. Write CodeSquad-specific install marker so uninstall can
    //    always find a CodeSquad-owned file to remove, even when the
    //    shared MCP entry was already cleaned by the CodeBuddy target.
    files.push(writeInstallMarker(loc));

    // 3. For local install, also write enableAllProjectMcpServers flag
    //    into .codebuddy/settings.json so CodeSquad auto-discovers the
    //    project MCP config.
    if (loc === 'local') {
      files.push(writeEnableProjectMcpServers());
    }

    return {
      files,
      notes: loc === 'local'
        ? ['Restart CodeSquad for MCP changes to take effect.']
        : [],
    };
  }

  uninstall(loc: Location): WriteResult {
    const files: WriteResult['files'] = [];

    // 1. Remove MCP server entry from .mcp.json (shared with CodeBuddy).
    //    This may already be gone if the CodeBuddy target cleaned it
    //    first — that's fine; the install marker below guarantees a
    //    CodeSquad-owned file to remove.
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

    // 2. Remove the install marker. This is the file we OWN exclusively,
    //    so it's guaranteed to exist when codesquad was installed and
    //    gives uninstallTargets a reliable 'removed' result.
    files.push(removeInstallMarker(loc));

    // 3. For local uninstall, remove the enableAllProjectMcpServers flag.
    if (loc === 'local') {
      files.push(removeEnableProjectMcpServers());
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

    if (loc === 'local') {
      const settingsSnippet = JSON.stringify(
        { enableAllProjectMcpServers: true },
        null,
        2,
      );
      return [
        `# Add MCP server to ${target}`,
        '',
        snippet,
        '',
        `# Also enable project MCP servers in ${codebuddySettingsPath()}`,
        '',
        settingsSnippet,
        '',
      ].join('\n');
    }

    return `# Add to ${target}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    const paths = [mcpJsonPath(loc), installMarkerPath(loc)];
    if (loc === 'local') {
      paths.push(codebuddySettingsPath());
    }
    return paths;
  }
}

export const codesquadTarget: AgentTarget = new CodeSquadTarget();
