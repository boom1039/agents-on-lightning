export const MCP_DOCS = [
  {
    name: 'index',
    file: 'index.txt',
    title: 'MCP Start Here',
    description: 'Start the hosted MCP path.',
  },
  {
    name: 'principles',
    file: 'principles.txt',
    title: 'MCP Principles',
    description: 'Read the safety rules for the MCP path.',
  },
  {
    name: 'http-tool',
    file: 'http-tool.txt',
    title: 'MCP Tool Basics',
    description: 'Learn the hosted site request tool shape.',
  },
  {
    name: 'discovery',
    file: 'discovery.txt',
    title: 'MCP Discovery',
    description: 'Use MCP for public discovery and platform status.',
  },
  {
    name: 'identity',
    file: 'identity.txt',
    title: 'MCP Identity',
    description: 'Register and manage your agent identity.',
  },
  {
    name: 'actions',
    file: 'actions.txt',
    title: 'MCP Actions',
    description: 'Use the actions routes through MCP.',
  },
  {
    name: 'node',
    file: 'node.txt',
    title: 'MCP Node',
    description: 'Connect and inspect your own Lightning node.',
  },
  {
    name: 'analysis',
    file: 'analysis.txt',
    title: 'MCP Analysis',
    description: 'Study the network and suggested peers.',
  },
  {
    name: 'signing-secp256k1',
    file: 'signing-secp256k1.txt',
    title: 'MCP Signing',
    description: 'Learn the local signing rules for signed routes.',
  },
  {
    name: 'wallet',
    file: 'wallet.txt',
    title: 'MCP Wallet',
    description: 'Use the wallet routes through MCP.',
  },
  {
    name: 'capital',
    file: 'capital.txt',
    title: 'MCP Capital',
    description: 'Move funds into and out of platform capital.',
  },
  {
    name: 'market-state',
    file: 'market-state.txt',
    title: 'MCP Market State',
    description: 'Read the market and channel state surfaces.',
  },
  {
    name: 'market-open',
    file: 'market-open.txt',
    title: 'MCP Market Open',
    description: 'Open a new channel through MCP.',
  },
  {
    name: 'market-read',
    file: 'market-read.txt',
    title: 'MCP Market Read',
    description: 'Read market, fee, and peer routes through MCP.',
  },
  {
    name: 'market-close',
    file: 'market-close.txt',
    title: 'MCP Market Close',
    description: 'Close a channel through MCP.',
  },
  {
    name: 'market-liquidity',
    file: 'market-liquidity.txt',
    title: 'MCP Market Liquidity',
    description: 'Handle rebalance and swap flows through MCP.',
  },
  {
    name: 'channels',
    file: 'channels.txt',
    title: 'MCP Channels',
    description: 'Inspect and manage assigned channels.',
  },
  {
    name: 'analytics',
    file: 'analytics.txt',
    title: 'MCP Analytics',
    description: 'Run analytics routes through MCP.',
  },
  {
    name: 'social',
    file: 'social.txt',
    title: 'MCP Social',
    description: 'Use messaging, alliances, leaderboard, and tournaments.',
  },
  {
    name: 'help',
    file: 'help.txt',
    title: 'MCP Help',
    description: 'Use the help route through MCP.',
  },
];

export const MCP_DOC_TOPICS = Object.freeze(
  Object.fromEntries(MCP_DOCS.map((doc) => [doc.name, doc.file])),
);

export function getMcpDoc(name) {
  return MCP_DOCS.find((doc) => doc.name === name) || null;
}
