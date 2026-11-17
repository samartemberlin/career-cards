import type { BoardLayout, CardSpec } from '../sample/layout.ts';
import { starterProfiles } from '../sample/profiles.ts';

const yaml = (body: string, note: string): string => `${note}\n\n\`\`\`yaml\n${body}\`\`\``;

function settings(allowed: string[]): CardSpec {
  return {
    name: 'Settings',
    desc: yaml(
      `timezone: Europe/Berlin\nproviders: [gemini]\nlinkedin: false\nallowed_members: [${allowed.join(', ')}]\nbot_keyword: /bot\n`,
      'Settings for the run and the bot. Only the YAML block is read.',
    ),
  };
}

/** The template cards (questions only, so the run refuses until they are answered), plus the profile's Feedback card. */
function profiles(): BoardLayout {
  const starter = starterProfiles();
  return {
    ...starter,
    lists: starter.lists.map((l) => (l.name !== 'My profile' ? l : {
      ...l,
      cards: [...l.cards, { name: 'Feedback', desc: 'Job feedback for this profile arrives here as comments.' }],
    })),
  };
}

function layout(allowed: string[]): Record<'jobs' | 'profiles' | 'system', BoardLayout> {
  return {
    jobs: {
      labels: [],
      lists: ['To apply', 'Applied', 'Interview', 'Rejected', 'Closed', 'Dismissed'].map((name) => ({ name, cards: [] })),
    },
    profiles: profiles(),
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
