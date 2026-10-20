export function assertEnglishSubmission(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > 60000) throw new Error('English submission is empty or too large. Nothing was sent.');
  if (/\p{Script=Han}/u.test(text)) throw new Error('提交中仍含中文字符（包括代码、路径或引号内文字），已停止发送。请改用英文内容后重试。');
  return text;
}

export async function prepareEnglishSubmission(translator, source) {
  if (typeof source !== 'string' || !source.trim() || source.length > 24000) throw new Error('Enter a request of 1–24000 characters.');
  const text = assertEnglishSubmission(await translator.translate(source, 'en'));
  return { text, englishOnly: true, originalIncluded: false };
}
