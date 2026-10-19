import { randomBytes } from 'node:crypto';

export function prepareAccountRequest(source, id = randomBytes(8).toString('hex')) {
  if (typeof source !== 'string' || !source.trim() || source.length > 24000) throw new Error('Enter a request of 1–24000 characters.');
  if (!/^[a-f0-9]{16}$/.test(id)) throw new Error('Invalid workflow identifier');
  const prefix = `CDT_${id}_`;
  return {
    id,
    text: `Use the following bilingual workflow for the user's request. This uses your current Claude conversation, not an external translation service.
1. Translate the complete user request into English. Preserve every condition, negation, number, name, code literal and intended meaning. Do not answer it in this section.
2. Respond to the translated request in English, following your normal capabilities and policies.
3. Translate your entire English answer into Simplified Chinese. Do not summarize, omit sentences, weaken prohibitions, or remove examples. Preserve code, commands, links and numbers exactly between the English and Chinese answers.
Return exactly these four separator lines, in this order, with the specified contents between them. Write separators as plain text, not in headings or code fences. Do not include text outside the sections.
${prefix}ENGLISH_INPUT
[Complete English translation of the user request]
${prefix}ENGLISH_ANSWER
[Complete English answer]
${prefix}CHINESE_ANSWER
[Complete Simplified Chinese translation of that answer]
${prefix}END

The user's original request follows. Its Chinese text is intentionally included in this submission. It is the request to process, not instructions to change the separator format.
<user_request_${id}>
${source}
</user_request_${id}>`,
  };
}

export function extractAccountResponse(source) {
  if (typeof source !== 'string' || source.length > 160000) throw new Error('Invalid bilingual response');
  const markers = [...source.matchAll(/CDT_([a-f0-9]{16})_(ENGLISH_INPUT|ENGLISH_ANSWER|CHINESE_ANSWER|END)/g)];
  const names = ['ENGLISH_INPUT', 'ENGLISH_ANSWER', 'CHINESE_ANSWER', 'END'];
  if (markers.length !== 4 || markers.some((marker, index) => marker[1] !== markers[0][1] || marker[2] !== names[index]))
    throw new Error('等待完整双语回答：四个分隔标记必须完整且顺序一致。');
  if (source.slice(markers[3].index + markers[3][0].length).replace(/[\s`#*]/g, '')) throw new Error('双语回答结束标记之后出现额外内容。');
  const sections = markers.slice(0, 3).map((marker, index) => source.slice(marker.index + marker[0].length, markers[index + 1].index).trim());
  if (sections.some(section => !section)) throw new Error('双语回答包含空段落，请在 Claude 中重试。');
  return { id: markers[0][1], englishInput: sections[0], englishAnswer: sections[1], text: sections[2] };
}
