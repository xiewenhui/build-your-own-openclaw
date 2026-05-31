import type { LoadedSkill } from './loader.ts';
import { globalSkillRegistry } from './registry.ts';

export function resolveSkillBody(skill: LoadedSkill): string {
  return skill.body.replaceAll('{baseDir}', skill.dir);
}

export function buildSkillPromptSection(userMessage: string): string {
  const matched = globalSkillRegistry.resolveForMessage(userMessage);
  if (matched.length === 0) return '';

  const bodies = matched
    .map(s => `### ${s.frontmatter.name}\n${resolveSkillBody(s)}`)
    .join('\n\n---\n\n');
  return `\n\n## Available Skills\n\n${bodies}`;
}
