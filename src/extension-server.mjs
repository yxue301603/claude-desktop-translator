import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ListPromptsRequestSchema, GetPromptRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { prepareAccountRequest, extractAccountResponse } from './account-workflow.mjs';
import { assertEnglishSubmission } from './submission.mjs';
import { operation, openCompanion, startService, version } from './desktop-controller.mjs';

const textSchema = (maxLength = 24000) => ({ type: 'string', minLength: 1, maxLength });
const input = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
export const tools = [
  { name: 'translator_status', description: 'Read translation mode and availability without sending chat messages.', inputSchema: input({}), annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false } },
  { name: 'open_translation_window', description: 'Open the Windows translation companion. Does not send a chat message.', inputSchema: input({}), annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: 'prepare_english_request', description: 'Translate a complete request through the configured API or local model. Returns English only; rejects remaining Chinese, including inside code and paths. Never falls back to sending the original.', inputSchema: input({ text: textSchema() }), annotations: { readOnlyHint: true, openWorldHint: true } },
  { name: 'prepare_bilingual_request', description: 'LEGACY OPT-IN ONLY: prepare a bilingual workflow that includes the original Chinese. Unavailable in English-only modes.', inputSchema: input({ text: textSchema() }), annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'extract_bilingual_response', description: 'LEGACY OPT-IN ONLY: extract the complete Chinese answer from a marked bilingual reply.', inputSchema: input({ text: textSchema(150000) }), annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false } },
  { name: 'translate_text_offline', description: 'Translate a request into English with the installed local model. Returns English only. Available only in offline mode.', inputSchema: input({ text: textSchema(), target: { type: 'string', enum: ['en'] } }), annotations: { readOnlyHint: true, openWorldHint: false } },
];
export function availableTools(mode) {
  return tools.filter(tool => ['translator_status', 'open_translation_window'].includes(tool.name) || (mode === 'account' ? ['prepare_bilingual_request', 'extract_bilingual_response'].includes(tool.name) : tool.name === 'prepare_english_request' || mode === 'offline' && tool.name === 'translate_text_offline'));
}

export function createExtensionServer({ config, autoStart = true, ownerLease = '', open = openCompanion, request = operation, ensure = startService, report = () => {} }) {
  const legacy = config.mode === 'account';
  const server = new Server({ name: 'claude-desktop-translator', version }, { capabilities: { tools: {}, prompts: {} }, instructions: legacy ? 'Legacy bilingual mode was explicitly selected; it includes original Chinese.' : 'English-only submission mode. Translate outside the Claude conversation before submitting. Never return or submit original Chinese as a fallback. Chinese output translations are displayed in the companion, not returned to Claude through tools.' });
  let starting;
  const start = () => starting ||= open(config, { ownerPid: process.pid, ownerLease, inlineService: true, report }).finally(() => { starting = null; });
  let autoOpened = false;
  const connected = () => { if (autoOpened) return; autoOpened = true; report(`MCP connected; mode=${config.mode}; auto_start=${autoStart}`); if (autoStart) start().catch(error => report(error.message)); };
  const english = async text => { await ensure(config, { inline: true }); const result = await request(config, '/prepare', 'POST', { text }); assertEnglishSubmission(result.text); return result; };
  server.oninitialized = connected;
  server.setRequestHandler(ListToolsRequestSchema, () => { connected(); return { tools: availableTools(config.mode) }; });
  server.setRequestHandler(ListPromptsRequestSchema, () => ({ prompts: [{ name: legacy ? 'bilingual_request' : 'english_request', description: legacy ? 'Legacy workflow including original Chinese.' : 'Translate the request before inserting an English-only prompt.', arguments: [{ name: 'text', description: 'The complete request.', required: true }] }] }));
  server.setRequestHandler(GetPromptRequestSchema, async ({ params }) => {
    if (params.name !== (legacy ? 'bilingual_request' : 'english_request')) throw new Error('Prompt is not available in this mode');
    let prepared;
    try { prepared = legacy ? prepareAccountRequest(params.arguments?.text) : await english(params.arguments?.text); }
    catch { throw new Error('Translation unavailable or not English-only. Nothing was submitted. Check translation settings.'); }
    return { description: legacy ? 'Legacy workflow; includes original text.' : 'English-only translated request.', messages: [{ role: 'user', content: { type: 'text', text: prepared.text } }] };
  });
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    try {
      const args = params.arguments || {}, definition = availableTools(config.mode).find(tool => tool.name === params.name);
      if (!definition) throw new Error('Tool is not available in this mode');
      const keys = Object.keys(definition.inputSchema.properties);
      if (Object.keys(args).some(key => !keys.includes(key)) || keys.some(key => !(key in args))) throw new Error('Invalid tool arguments');
      let result;
      if (params.name === 'translator_status') {
        try { result = { running: true, ...await request(config, '/status') }; } catch { result = { running: false, mode: config.mode, version }; }
        result.localModelRequired = config.mode === 'offline'; result.englishOnly = !legacy;
      } else if (params.name === 'open_translation_window') result = await start();
      else if (params.name === 'prepare_english_request') result = await english(args.text);
      else if (params.name === 'prepare_bilingual_request') result = prepareAccountRequest(args.text);
      else if (params.name === 'extract_bilingual_response') result = extractAccountResponse(args.text);
      else { if (args.target !== 'en') throw new Error('Only English output is allowed'); result = await english(args.text); }
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    } catch { return { isError: true, content: [{ type: 'text', text: 'Translation unavailable, incomplete, or not English-only. Nothing was submitted. Check the companion and translation settings.' }] }; }
  });
  return server;
}
