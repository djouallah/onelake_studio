'use strict';
// skill.js — the agent skill's file (Claude Code, GitHub Copilot).
// bin/cli.mjs is this extension's modules from a shell; claude-skill/SKILL.md tells an agent
// when and how to run it. Installing writes the skill to ~/.claude/skills/onelake/ — read by
// Claude Code and by GitHub Copilot in VS Code, so one copy serves both — with the
// path of THIS install's cli.mjs filled in — a path that changes with every update, so a skill
// this extension wrote (it carries the marker) is rewritten at each activation. One the user
// wrote themselves, without the marker, is never touched unless they ask.

const { join, dirname } = require('node:path');
const os = require('node:os');
const fsp = require('node:fs/promises');

const SKILL_MARKER = 'Installed by the OneLake Studio extension';
const skillFile = () => join(os.homedir(), '.claude', 'skills', 'onelake', 'SKILL.md');

async function writeSkill(extensionDir) {
  const template = await fsp.readFile(join(extensionDir, 'claude-skill', 'SKILL.md'), 'utf8');
  const cli = join(extensionDir, 'bin', 'cli.mjs').replace(/\\/g, '/');
  const text = template.split('{{cli}}').join(cli);
  const file = skillFile();
  const before = await fsp.readFile(file, 'utf8').catch(() => null);
  if (before === text) return false;
  await fsp.mkdir(dirname(file), { recursive: true });
  await fsp.writeFile(file, text);
  return true;
}

async function refreshSkill(extensionDir, log) {
  const before = await fsp.readFile(skillFile(), 'utf8').catch(() => null);
  if (before && before.includes(SKILL_MARKER) && await writeSkill(extensionDir)) {
    log(`agent skill updated at ${skillFile()}`);
  }
}

module.exports = { SKILL_MARKER, skillFile, writeSkill, refreshSkill };
