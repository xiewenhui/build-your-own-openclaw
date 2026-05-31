import { execFileSync } from 'child_process';
import { loadSkill, scanSkills, type LoadedSkill } from './loader.ts';

function commandExists(bin: string): boolean {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [bin], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export class SkillRegistry {
  private skills = new Map<string, LoadedSkill>();

  addSkill(skill: LoadedSkill): void {
    this.skills.set(skill.frontmatter.name, skill);
  }

  addDir(dir: string): void {
    for (const skill of scanSkills(dir)) {
      this.addSkill(skill);
    }
  }

  getAll(): LoadedSkill[] {
    return [...this.skills.values()];
  }

  getByName(name: string): LoadedSkill | undefined {
    return this.skills.get(name);
  }

  checkRequirements(skill: LoadedSkill): { ok: boolean; missing: string[] } {
    const req = skill.frontmatter.metadata?.openclaw?.requires;
    if (!req) return { ok: true, missing: [] };

    const missingBins = (req.bins ?? []).filter(b => !commandExists(b));
    const missingEnv = (req.env ?? []).filter(e => !process.env[e]);
    const missing = [
      ...missingBins.map(b => `bin:${b}`),
      ...missingEnv.map(e => `env:${e}`),
    ];
    return { ok: missing.length === 0, missing };
  }

  // Keyword-based dispatch: match description words against user message.
  // Uses whole-word set intersection — requires ≥ 2 keyword hits to avoid false positives
  // from incidental matches (e.g. "memory" in a coding question triggering the sysinfo skill).
  resolveForMessage(userMessage: string): LoadedSkill[] {
    const msgWords = new Set(userMessage.toLowerCase().split(/\W+/).filter(w => w.length > 3));
    return [...this.skills.values()].filter(skill => {
      // Skills marked user-invocable: false are reference docs for tools, not auto-injectable.
      if (skill.frontmatter['user-invocable'] === false) return false;
      const { ok } = this.checkRequirements(skill);
      if (!ok) return false;
      const keywords = skill.frontmatter.description.toLowerCase().split(/\W+/).filter(w => w.length > 3);
      const hits = keywords.filter(kw => msgWords.has(kw)).length;
      // Require at least 2 matching keywords (or all of them if the description is very short).
      return hits >= Math.min(2, keywords.length);
    });
  }

  // Get all skills available by name (for /skills command).
  listStatus(): Array<{ skill: LoadedSkill; ok: boolean; missing: string[] }> {
    return [...this.skills.values()].map(skill => ({
      skill,
      ...this.checkRequirements(skill),
    }));
  }
}

export const globalSkillRegistry = new SkillRegistry();
