const fs = require('fs');
const path = require('path');

const VALID_FILES = new Set(['SOUL', 'AGENTS', 'USER']);

const definitions = [
  {
    name: 'propose_personality_edit',
    description: 'Propose a change to your own personality files (SOUL.md, AGENTS.md, USER.md). The proposal is saved for the user to review and approve. Use when you notice something about yourself or the user that should be reflected in your personality.',
    input_schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          enum: ['SOUL', 'AGENTS', 'USER'],
          description: 'Which personality file to change',
        },
        section: {
          type: 'string',
          description: 'Which section of the file to change (optional, helps locate the edit)',
        },
        change: {
          type: 'string',
          description: 'The proposed edit — what to add, remove, or modify',
        },
        reason: {
          type: 'string',
          description: 'Why this change should be made',
        },
      },
      required: ['file', 'change', 'reason'],
    },
  },
];

const handlers = {
  async propose_personality_edit(input, _memory, context) {
    const { file, section, change, reason } = input;

    if (!VALID_FILES.has(file)) {
      return `Invalid file: ${file}. Must be one of: ${[...VALID_FILES].join(', ')}`;
    }

    const userDir = context.userDir;
    if (!userDir) return 'User directory not available.';

    const proposalsDir = path.join(userDir, 'personality', 'proposals');
    try {
      fs.mkdirSync(proposalsDir, { recursive: true });
    } catch (e) {
      return `Failed to create proposals directory: ${e.message}`;
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const proposal = {
      file,
      section: section || null,
      change,
      reason,
      status: 'pending',
      created_at: new Date().toISOString(),
    };

    const proposalPath = path.join(proposalsDir, `${timestamp}-${file}.json`);
    try {
      fs.writeFileSync(proposalPath, JSON.stringify(proposal, null, 2));
    } catch (e) {
      return `Failed to save proposal: ${e.message}`;
    }

    console.log(`[personality] Proposal saved: ${proposalPath}`);
    console.log(`[personality]   File: ${file}, Section: ${section || '(global)'}`);
    console.log(`[personality]   Change: ${change}`);
    console.log(`[personality]   Reason: ${reason}`);

    return `Proposal saved to ${path.basename(proposalPath)}. Run \`/personality approve\` to review and apply pending proposals.`;
  },
};

module.exports = { definitions, handlers };
