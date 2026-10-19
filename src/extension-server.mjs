import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ListPromptsRequestSchema, GetPromptRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { prepareAccountRequest, extractAccountResponse } from './account-workflow.mjs';
import { operation, openCompanion, startService, version } from './desktop-controller.mjs';

const textSchema = (maxLength = 24000) => ({ type: 'string', minLength: 1, maxLength });
const input = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
export const tools = [
  { name: 'translator_status', description: 'Read translator mode and availability. Does not open a window or send a message.', inputSchema: input({}), annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false } },
  { name: 'open_translation_window', description: 'Open the Windows Chinese/English companion. Account mode needs no local model; offline mode needs installed Ollama weights. Does not send chat messages.', inputSchema: input({}), annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: 'prepare_bilingual_request', description: 'Prepare instructions for the current Claude account to translate and answer a request bilingually. This tool itself does not translate or call a model. The prepared message intentionally includes the original Chinese; it is not English-only preprocessing.', inputSchema: input({ text: textSchema() }), annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'extract_bilingual_response', description: 'Extract the complete Chinese section from a marked bilingual Claude answer. Rejects incomplete, reordered or mixed sections. Does not call a model.', inputSchema: input({ text: textSchema(150000) }), annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false } },
  { name: 'translate_text_offline', description: 'Translate a complete text with the installed local model. Available only when the extension mode is offline. Never silently changes backend or downloads weights.', inputSchema: input({ text: textSchema(), target: { type: 'string', enum: ['en', 'zh'] } }), annotations: { readOnlyHint: true, openWorldHint: false } },
];

export function createExtensionServer({ config, autoStart = true, ownerLease = '', open = openCompanion, request = operation, ensure = startService, report = () => {} }) {
  const server = new Server({ name: 'claude-desktop-translator', version }, { capabilities: { tools: {}, prompts: {} }, instructions: 'This extension supports account bilingual workflows and offline translation. Account mode does not pretranslate Chinese before submission. Do not describe prepared instructions as an already completed translation.' });
  let starting;
  const start = () => starting ||= open(config, { ownerPid: process.pid, ownerLease, inlineService: true, report }).finally(() => { starting = null; });
  let autoOpened = false;
  const connected = () => {
    if (autoOpened) return;
    autoOpened = true; report(`MCP connected; mode=${config.mode}; auto_start=${autoStart}`);
    if (autoStart) start().catch(error => report(error.message));
  };
  server.oninitialized = connected;
  server.setRequestHandler(ListToolsRequestSchema, () => { connected(); return { tools }; });
  server.setRequestHandler(ListPromptsRequestSchema, () => ({ prompts: [{ name: 'bilingual_request', description: 'Use your current Claude account to translate a request, answer in English, then provide the complete Chinese answer. No Ollama is needed.', arguments: [{ name: 'text', description: 'Your complete request, including any code and constraints.', required: true }] }] }));
  server.setRequestHandler(GetPromptRequestSchema, ({ params }) => {
    if (params.name !== 'bilingual_request') throw new Error('Unknown prompt');
    return { description: 'Account bilingual workflow; the original text is included.', messages: [{ role: 'user', content: { type: 'text', text: prepareAccountRequest(params.arguments?.text).text } }] };
  });
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    try {
      const args = params.arguments || {};
      const definition = tools.find(tool => tool.name === params.name);
      if (!definition) throw new Error('Unknown translator tool');
      const keys = Object.keys(definition.inputSchema.properties);
      if (Object.keys(args).some(key => !keys.includes(key)) || keys.some(key => !(key in args))) throw new Error('Invalid tool arguments');
      let result;
      if (params.name === 'translator_status') {
        try { result = { running: true, ...await request(config, '/status') }; }
        catch { result = { running: false, mode: config.mode, version }; }
        result.localModelRequired = config.mode === 'offline';
      } else if (params.name === 'open_translation_window') { result = await start(); }
      else if (params.name === 'prepare_bilingual_request') result = prepareAccountRequest(args.text);
      else if (params.name === 'extract_bilingual_response') result = extractAccountResponse(args.text);
      else {
        if (config.mode !== 'offline') throw new Error('Switch extension mode to offline before using local translation. Account mode uses the bilingual_request prompt.');
        if (!['en', 'zh'].includes(args.target) || typeof args.text !== 'string' || !args.text.trim() || args.text.length > 24000) throw new Error('Invalid translation text or direction');
        await ensure(config, { inline: true });
        result = await request(config, '/translate', 'POST', args);
      }
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    } catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
  });
  return server;
}
