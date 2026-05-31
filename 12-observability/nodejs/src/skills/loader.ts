import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

export interface SkillFrontmatter {
  name: string;
  description: string;
  'user-invocable'?: boolean;
  metadata?: {
    openclaw?: {
      emoji?: string;
      os?: string[];
      requires?: {
        bins?: string[];
        env?: string[];
      };
      install?: Array<{
        id: string;
        kind: string;
        formula?: string;
        package?: string;
        bins?: string[];
        label: string;
      }>;
    };
  };
}

export interface LoadedSkill {
  frontmatter: SkillFrontmatter;
  body: string;
  dir: string;
}

export function loadSkill(skillDir: string): LoadedSkill | null {
  const mdPath = path.join(skillDir, 'SKILL.md');
  if (!fs.existsSync(mdPath)) return null;

  const raw = fs.readFileSync(mdPath, 'utf8');
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return null;

  const frontmatter = yaml.load(match[1]!) as SkillFrontmatter;
  const body = match[2]!.trim();

  return { frontmatter, body, dir: skillDir };
}

export function scanSkills(dir: string): LoadedSkill[] {
  if (!fs.existsSync(dir)) return [];
  const skills: LoadedSkill[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skill = loadSkill(path.join(dir, entry.name));
    if (skill) skills.push(skill);
  }
  return skills;
}
