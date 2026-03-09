const MAX_EXEC_TIMEOUT = 120;
let MAX_TOOL_ITERATIONS = 100;

const OPTIONAL_TOOLS = {
  speech_to_text: {
    label: 'Speech to Text',
    tools: ['transcribe_audio'],
    config: {},
  },
  text_to_speech: {
    label: 'Text to Speech',
    tools: ['text_to_speech', 'tts_voices'],
    config: {
      voice: { label: 'Voice', default: 'en-US-JennyNeural' },
    },
  },
  create_pdf: {
    label: 'PDF Generator',
    tools: ['create_pdf'],
    config: {},
  },
  background: {
    label: 'Background Tasks',
    tools: ['background_task'],
    config: {},
  },
  mermaid: {
    label: 'Flowchart',
    tools: ['mermaid_chart'],
    config: {},
  },
  model_stats: {
    label: 'Model Stats',
    tools: [],
    config: {},
    defaultEnabled: true,
  },
  proactive_news: {
    label: 'Proactive News',
    tools: [],
    config: {
      topics: { label: 'Topics', default: [] },
    },
  },
};

const BLOCKED_EXEC_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*f|-[a-zA-Z]*r|--force|--recursive)\b/,
  /\bshutdown\b/, /\breboot\b/, /\bpoweroff\b/,
  /\bmkfs\b/, /\bdd\s+if=/, /\b:()\{\s*:|:&\s*\};:/,
  /\bchmod\s+(-R\s+)?[0-7]*\s+\/[^t]/,
  />\s*\/etc\//, />\s*\/boot\//,
  /\bcurl\b.*\|\s*(ba)?sh/, /\bwget\b.*\|\s*(ba)?sh/,
  /\bnc\s+-e\b/, /\bncat\b.*-e\b/,
  />\s*\/dev\/sd/,
];

const SENSITIVE_READ_PATHS = [
  /\/etc\/(passwd|shadow|sudoers)/,
  /\/etc\/ssh\//,
  /\.(env|pem|key|crt|p12|pfx)(\s|$)/,
  /~\/\.ssh\//,
  /~\/\.gnupg\//,
  /\/root\//,
];

function getMaxToolIterations() { return MAX_TOOL_ITERATIONS; }
function setMaxToolIterations(n) { MAX_TOOL_ITERATIONS = n; }

module.exports = {
  MAX_EXEC_TIMEOUT,
  OPTIONAL_TOOLS,
  BLOCKED_EXEC_PATTERNS,
  SENSITIVE_READ_PATHS,
  getMaxToolIterations,
  setMaxToolIterations,
};
