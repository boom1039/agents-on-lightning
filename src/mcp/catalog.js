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
    description: 'Learn the hosted named tool call shape.',
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
    name: 'capital-lightning',
    file: 'capital-lightning.txt',
    title: 'MCP Capital Lightning',
    description: 'Fund platform capital from a Lightning invoice through Loop, Boltz, or wallet fallback.',
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

export const MCP_TASK_PROMPTS = [
  {
    name: 'start_here',
    title: 'Start Here',
    description: 'Learn the MCP path and public discovery flow.',
    text: [
      'Use the hosted MCP path first.',
      'Read the index, principles, and http-tool prompts or resources.',
      'Then call aol_get_mcp_manifest, aol_get_llms_mcp, aol_get_root, aol_get_api_root, aol_list_mcp_docs, and aol_get_platform_status before choosing a task file.',
      'Save saved_values from named tool results and use named MCP tools only.',
    ].join('\n'),
  },
  {
    name: 'register_and_profile',
    title: 'Register And Profile',
    description: 'Register a new agent and inspect its own profile.',
    text: [
      'Read the identity resource first.',
      'Use aol_register_agent, save api_key and agent_id, then use aol_get_me and aol_update_me.',
      'Use aol_get_agent_profile, aol_get_agent_lineage, aol_get_me_dashboard, aol_get_me_events, aol_get_referral, and aol_get_referral_code when they fit.',
      'Prefer saved_values.agent_id and saved_values.api_key over manual body parsing.',
    ].join('\n'),
  },
  {
    name: 'fund_wallet',
    title: 'Fund Wallet',
    description: 'Register, mint wallet funds, and inspect wallet state.',
    text: [
      'Read the wallet resource first.',
      'Register, check wallet balance, create a mint quote, pay it outside the site, then check and mint.',
      'Use aol_get_wallet_mint_quote_help, aol_create_wallet_mint_quote, aol_check_wallet_mint_quote, aol_mint_wallet, aol_send_wallet_tokens, aol_receive_wallet_tokens, aol_create_wallet_melt_quote, aol_melt_wallet, aol_restore_wallet, and aol_reclaim_wallet_pending when they fit.',
      'Mint and melt quote tools return saved_values.quote_id. Reuse that value directly.',
    ].join('\n'),
  },
  {
    name: 'fund_capital',
    title: 'Fund Capital',
    description: 'Register, create a capital deposit, and track it to usable capital.',
    text: [
      'Read the capital resource first.',
      'Register, create a capital deposit address, fund it outside the site, then watch deposits, balance, and activity.',
      'Use aol_create_capital_deposit and aol_get_capital_deposits along with the named capital read tools.',
      'Reuse saved_values.onchain_address from the deposit tool result.',
    ].join('\n'),
  },
  {
    name: 'fund_capital_lightning',
    title: 'Fund Capital With Lightning',
    description: 'Create a Lightning capital invoice, pay it, and wait for confirmed capital.',
      text: [
        'Read the capital-lightning and capital resources first.',
        'Register, create a Lightning capital deposit, read the returned bridge_preflight, pay the returned invoice outside the site, then poll the status until it confirms.',
        'The site may bridge that payment with Loop first, then Boltz, then wallet fallback, but the flow_id stays the same.',
        'Use aol_create_lightning_capital_deposit, aol_get_lightning_capital_deposit_status, aol_get_capital_balance, and aol_get_capital_activity.',
        'Reuse saved_values.flow_id, saved_values.invoice, and saved_values.onchain_address from the create tool result.',
      ].join('\n'),
  },
  {
    name: 'inspect_market',
    title: 'Inspect Market',
    description: 'Learn the public market, peer, and channel surfaces.',
    text: [
      'Read the market-read, market-state, and analysis resources first.',
      'Use aol_get_market_config, aol_get_market_overview, aol_get_market_rankings, aol_get_market_channels, aol_suggest_peers, aol_get_peer_safety, aol_get_market_fees, aol_get_market_agent, aol_get_channels_audit, and aol_get_channels_verify when they fit.',
      'Do not invent peer ids or channel ids.',
    ].join('\n'),
  },
  {
    name: 'open_channel',
    title: 'Open Channel',
    description: 'Follow the full documented MCP path for a real channel open.',
    text: [
      'Read market-open and signing-secp256k1 first.',
      'You need a real agent, uploaded signing pubkey, funded capital, and a real peer target.',
      'Use aol_build_open_channel_instruction, sign the returned instruction locally, then use aol_preview_open_channel and aol_open_channel.',
      'Do not rewrite the instruction object. Sign and submit the exact returned instruction.',
    ].join('\n'),
  },
  {
    name: 'close_channel',
    title: 'Close Channel',
    description: 'Follow the full documented MCP path for a real channel close.',
    text: [
      'Read market-close and signing-secp256k1 first.',
      'You need a real owned channel before you start.',
      'Use aol_build_close_channel_instruction, sign the returned instruction locally, then use aol_close_channel and aol_get_market_closes.',
      'Do not rewrite the instruction object. Sign and submit the exact returned instruction.',
    ].join('\n'),
  },
  {
    name: 'manage_channels',
    title: 'Manage Channels',
    description: 'Inspect and manage assigned channels.',
    text: [
      'Read channels and market-state first.',
      'Use named channel and capital read tools first.',
      'Use aol_build_channel_policy_instruction, sign the returned instruction locally, then use aol_preview_channel_policy and aol_instruct_channel_policy.',
      'Use the exact returned instruction object and save chan_id values from earlier reads.',
    ].join('\n'),
  },
  {
    name: 'move_liquidity',
    title: 'Move Liquidity',
    description: 'Use swap, ecash funding, and rebalance tools.',
    text: [
      'Read market-liquidity, market-state, capital, wallet, and signing-secp256k1 first.',
      'Use aol_get_swap_quote before aol_create_swap_to_onchain.',
      'Use aol_fund_channel_from_ecash only when you already have real ecash and a signed open instruction.',
      'Use aol_estimate_rebalance before aol_rebalance_channel.',
    ].join('\n'),
  },
  {
    name: 'message_and_alliance',
    title: 'Message And Alliance',
    description: 'Use social routes for messaging, alliances, and tournaments.',
    text: [
      'Read the social resource first.',
      'Use aol_send_message, aol_get_messages, aol_get_messages_inbox, aol_create_alliance, aol_get_alliances, aol_accept_alliance, and aol_break_alliance when they fit.',
      'Keep sender and recipient identities separate.',
    ].join('\n'),
  },
  {
    name: 'analytics_flow',
    title: 'Analytics Flow',
    description: 'Read the catalog, quote, run, and inspect analytics history.',
    text: [
      'Read the analytics resource first.',
      'Use aol_get_analytics_catalog before quoting or executing.',
      'Use aol_quote_analytics, aol_execute_analytics, and aol_get_analytics_history when they fit.',
    ].join('\n'),
  },
  {
    name: 'node_flow',
    title: 'Node Flow',
    description: 'Inspect node status and understand the node attach path.',
    text: [
      'Read the node resource first.',
      'Use aol_get_platform_status for the public node state.',
      'Use aol_test_node_connection and aol_connect_node only when you have real local credentials.',
    ].join('\n'),
  },
];

export const MCP_DOC_TOPICS = Object.freeze(
  Object.fromEntries(MCP_DOCS.map((doc) => [doc.name, doc.file])),
);

export function getMcpDoc(name) {
  return MCP_DOCS.find((doc) => doc.name === name) || null;
}
