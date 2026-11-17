// Builds the nightly scan plan from the config/defaults files plus whatever the Sources card says to Add or Drop.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';
import { mergePortals, mergeLinkedin } from '../pipeline/search.ts';
import type { Compiled } from '../compile/schema.ts';
import { specOf } from '../config/cards.ts';
import type { Sources, Settings } from '../config/schema.ts';
import type { LinkedInConfig } from '../pipeline/sources/linkedin.ts';
import type { RssSource } from '../pipeline/sources/rss.ts';
import type { PageSource } from '../pipeline/sources/pages.ts';

export type Defaults = {
  portals: Record<string, unknown>;
  extra: { rss?: RssSource[]; pages?: PageSource[]; linkedin?: LinkedInConfig };
};

export type ScanPlan = {
  portals: Record<string, unknown>;
  rss: RssSource[];
  pages: PageSource[];
  linkedin: LinkedInConfig | null;
  warnings: string[];
};

const DEFAULTS_DIR = join(fileURLToPath(import.meta.url), '../../..', 'config', 'defaults');

/** Reads portals.yml and extra-sources.yml from the defaults directory. Never mutate the result. */
export function loadDefaults(dir: string = DEFAULTS_DIR): Defaults {
  const portals = loadYaml(readFileSync(join(dir, 'portals.yml'), 'utf8')) as Record<string, unknown>;
  const extra = loadYaml(readFileSync(join(dir, 'extra-sources.yml'), 'utf8')) as {
    rss?: RssSource[];
    pages?: PageSource[];
    linkedin?: LinkedInConfig;
  };
  return { portals, extra };
}

type NamedItem = { name?: string; [key: string]: unknown };

/** Case-insensitive, trimmed name match. Items without a name field never match. */
const nameMatch = (item: NamedItem, drop: string): boolean =>
  item.name != null && item.name.trim().toLowerCase() === drop.trim().toLowerCase();

function applyDrop(
  defaults: Defaults,
  drops: string[],
): { portals: Record<string, unknown>; rss: RssSource[]; pages: PageSource[]; warnings: string[] } {
  // Deep-clone portals so we never mutate defaults.
  const portals = structuredClone(defaults.portals) as Record<string, unknown>;
  let rss = [...(defaults.extra.rss ?? [])];
  let pages = [...(defaults.extra.pages ?? [])];
  const warnings: string[] = [];

  for (const raw of drops) {
    let matched = false;

    const tryDrop = (arr: NamedItem[]): NamedItem[] => {
      const before = arr.length;
      const after = arr.filter((item) => !nameMatch(item, raw));
      if (after.length < before) matched = true;
      return after;
    };

    if (portals.tracked_companies) {
      const dropped = tryDrop(portals.tracked_companies as NamedItem[]);
      portals.tracked_companies = dropped;
    }
    if (portals.job_boards) {
      const dropped = tryDrop(portals.job_boards as NamedItem[]);
      portals.job_boards = dropped;
    }
    if (portals.interamt_searches) {
      const dropped = tryDrop(portals.interamt_searches as NamedItem[]);
      portals.interamt_searches = dropped;
    }
    rss = tryDrop(rss as NamedItem[]) as RssSource[];
    pages = tryDrop(pages as NamedItem[]) as PageSource[];

    if (!matched) warnings.push(`Sources › Drop: "${raw}" matches no default source`);
  }

  return { portals, rss, pages, warnings };
}

/**
 * Builds the complete scan plan for one run.
 * - Applies Sources Drop (removes named defaults) and Add (appends or replaces tracked_companies).
 * - Merges active profiles' search terms into portals (arbeitsagentur board) and LinkedIn (each compiled location).
 * - Returns linkedin: null when linkedin is off, or when it is on but the cards name no place to search.
 * Never mutates `defaults`.
 */
export function buildScanPlan(o: {
  defaults: Defaults;
  sources: Sources;
  settings: Settings;
  compiled: Compiled;
  activeProfiles: string[];
}): ScanPlan {
  const { defaults, sources, settings, compiled } = o;

  const { portals: droppedPortals, rss, pages, warnings } = applyDrop(defaults, sources.drop);

  // Apply Add: items whose name matches an existing tracked_company replace it entirely
  // (a merge would keep stale fields such as an old API endpoint); others are appended.
  if (sources.add.length) {
    const companies = (droppedPortals.tracked_companies as NamedItem[] | undefined) ?? [];
    for (const entry of sources.add) {
      const idx = companies.findIndex((c) => nameMatch(c, entry.name));
      if (idx >= 0) companies[idx] = entry as unknown as NamedItem;
      else companies.push(entry as unknown as NamedItem);
    }
    droppedPortals.tracked_companies = companies;
  }

  const active = new Set(o.activeProfiles.map((n) => n.toLowerCase()));
  const searches = compiled.profiles.filter((p) => active.has(p.name.toLowerCase())).map((p) => ({
    board_keywords: [...p.search_terms],
    linkedin: compiled.linkedin_locations.map((l) => ({ ...l, queries: [...p.search_terms] })),
  }));
  const portals = mergePortals(droppedPortals, searches);

  let linkedin: LinkedInConfig | null = null;
  if (settings.linkedin) {
    if (!compiled.linkedin_locations.length) {
      warnings.push(`LinkedIn is on but "${specOf('where').name}" names no place to search`);
    } else {
      const liBase = defaults.extra.linkedin ?? {};
      linkedin = mergeLinkedin(liBase, searches) as LinkedInConfig;
    }
  }

  return { portals, rss, pages, linkedin, warnings };
}
