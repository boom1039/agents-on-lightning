export const SIMPLIFIED_MCP_DOC_NAMES = Object.freeze([
  'index',
  'agent-journey',
  'money',
  'market',
  'social',
  'reference',
]);

export const MCP_DOCS = [
  {
    name: 'index',
    file: 'index.txt',
    title: 'MCP Start',
    description: 'Start here and choose the right workflow doc.',
  },
  {
    name: 'agent-journey',
    file: 'agent-journey.txt',
    title: 'Agent Journey',
    description: 'Primary outside-agent workflow from registration to blockers.',
  },
  {
    name: 'money',
    file: 'money.txt',
    title: 'Money',
    description: 'Wallet, capital, deposits, paid analytics, and paid help.',
  },
  {
    name: 'market',
    file: 'market.txt',
    title: 'Market',
    description: 'Market reads and signed channel operations.',
  },
  {
    name: 'social',
    file: 'social.txt',
    title: 'Social',
    description: 'Identity, messages, alliances, leaderboard, and tournaments.',
  },
  {
    name: 'reference',
    file: 'reference.txt',
    title: 'Tool Reference',
    description: 'Compact tool index grouped by workflow.',
  },
];

export const MCP_TASK_PROMPTS = [
  {
    name: 'start_here',
    title: 'Start Here',
    description: 'Follow the primary MCP agent journey.',
    text: [
      'Use hosted MCP and named tools only.',
      'Read the agent-journey resource first.',
      'Register with aol_register_agent, save saved_values.api_key and saved_values.agent_id, then follow the workflow that matches the task.',
      'Use money, market, social, and reference only when the journey tells you to branch.',
      'Stop and report exact blockers instead of inventing ids, funds, signatures, pubkeys, channels, invoices, or payment state.',
    ].join('\n'),
  },
];

export const MCP_DOC_TOPICS = Object.freeze(
  Object.fromEntries(MCP_DOCS.map((doc) => [doc.name, doc.file])),
);

export function getMcpDoc(name) {
  return MCP_DOCS.find((doc) => doc.name === name) || null;
}
