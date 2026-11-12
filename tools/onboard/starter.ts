import type { BoardLayout, CardSpec } from '../sample/layout.ts';

const yaml = (body: string, note: string): string => `${note}\n\n\`\`\`yaml\n${body}\`\`\``;

const RUBRIC = `Score 0-10 how well a job fits this profile: 8-10 apply now, 5-7 worth a look, 3-4 a stretch, 0-2 not a fit.

Fill the table with real roles and the score you would give them. Real examples rank jobs far better than a description of the scale.

| Role | Score |
|---|---|
|  |  |
`;

const FILTERS = ['Include titles', 'Exclude titles', 'Exclude companies', 'Exclude text', 'Exclude locations'];

function settings(allowed: string[]): CardSpec {
  return {
    name: 'Settings',
    desc: yaml(
      `timezone: Europe/Berlin\nproviders: [gemini]\nlocations: []\nlinkedin: false\nallowed_members: [${allowed.join(', ')}]\n`,
      'Settings for the run and the bot. Only the YAML block is read.',
    ),
  };
}

function layout(allowed: string[]): Record<'jobs' | 'profiles' | 'system', BoardLayout> {
  return {
    jobs: {
      labels: [],
      lists: ['To apply', 'Applied', 'Interview', 'Rejected', 'Closed', 'Dismissed'].map((name) => ({ name, cards: [] })),
    },
    profiles: {
      labels: [],
      lists: [
        { name: 'Originals', cards: [] },
        {
          name: 'Shared',
          cards: [
            { name: 'CV', desc: 'Replace this text with your CV, as plain text or Markdown.' },
            // Empty on purpose: the run refuses to score until the user lists what to mask.
            { name: 'Personal details', desc: 'One item per string to mask before any prompt: your name, email, phone, address, links.', checklists: [{ name: 'Personal details', items: [] }] },
          ],
        },
        {
          name: 'My profile',
          cards: [
            { name: 'Profile', desc: yaml('active: true\n', 'One column per profile. Set active: false to pause this one.') },
            { name: 'Rubric', desc: RUBRIC },
            { name: 'Search keywords', desc: 'One search term per item.', checklists: [{ name: 'Search keywords', items: [] }] },
            {
              name: 'Filters',
              desc: 'One pattern per item, optionally followed by " — " and a note.',
              checklists: FILTERS.map((name) => ({ name, items: [] })),
            },
            { name: 'Feedback', desc: 'Job feedback for this profile arrives here as comments.' },
          ],
        },
      ],
    },
    system: {
      labels: [],
      lists: [
        {
          name: 'Config',
          cards: [
            settings(allowed),
            { name: 'Sources', desc: 'Sources added to or dropped from the defaults, one per item.', checklists: [{ name: 'Add', items: [] }, { name: 'Drop', items: [] }] },
            { name: 'Schedule', desc: 'The nightly run is started by a Trello automation rule. Edit that rule to change the time.' },
          ],
        },
        { name: 'Runs', cards: [] },
      ],
    },
  };
}

/** With nobody in allowed_members, nobody can command the bot until `starterLayout` names the owner. */
export const STARTER: Record<'jobs' | 'profiles' | 'system', BoardLayout> = layout([]);

export function starterLayout(owner: string): Record<'jobs' | 'profiles' | 'system', BoardLayout> {
  return layout([owner]);
}
