import { describe, expect, it } from 'vitest';

import {
  INDUSTRY_PRESETS,
  allPipelineTemplates,
  findPipelineTemplate,
  missingPresetTags,
} from './industry-presets';

describe('industry presets', () => {
  it('has unique industry ids and pipeline template ids', () => {
    const ids = INDUSTRY_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    const tplIds = allPipelineTemplates().map((x) => x.pipeline.id);
    expect(new Set(tplIds).size).toBe(tplIds.length);
  });

  it('every industry ships tags and at least one pipeline with 3+ distinct stages', () => {
    for (const p of INDUSTRY_PRESETS) {
      expect(p.tags.length, p.id).toBeGreaterThan(0);
      const names = p.tags.map((t) => t.name.toLowerCase());
      expect(new Set(names).size, `${p.id} tag names unique`).toBe(names.length);
      expect(p.pipelines.length, p.id).toBeGreaterThan(0);
      for (const pl of p.pipelines) {
        expect(pl.stages.length, pl.id).toBeGreaterThanOrEqual(3);
        const stageNames = pl.stages.map((s) => s.name);
        expect(new Set(stageNames).size, `${pl.id} stage names unique`).toBe(stageNames.length);
        for (const s of pl.stages) expect(s.color).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });

  it('finds a template by id and returns null for unknown ids', () => {
    expect(findPipelineTemplate('saas-sales')?.name).toBe('SaaS Sales');
    expect(findPipelineTemplate('nope')).toBeNull();
  });

  it('missingPresetTags skips existing names case-insensitively and dedupes', () => {
    const preset = [
      { name: 'VIP', color: '#000000' },
      { name: 'Lead', color: '#000000' },
      { name: 'lead', color: '#111111' },
    ];
    const out = missingPresetTags(preset, [' vip ']);
    expect(out.map((t) => t.name)).toEqual(['Lead']);
  });
});
