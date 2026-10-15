import { createHash } from 'node:crypto';

export function protectLiterals(text) {
  const literals = [];
  const nonce = createHash('sha256').update(text).digest('hex').slice(0, 12);
  const pattern = /(^|\n)([ \t]*)(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n\2\3[^\n]*(?=\n|$)|$)|(`+)[^\n]*?\4|https?:\/\/[^\s<>]+|(?:[A-Za-z]:\\|(?<![\p{L}\p{N}])(?:\.\.?\/|\/))[\w\u3400-\u9fff.@\-\\/]+|<system-reminder>[\s\S]*?<\/system-reminder>|<[^>\n]+>/gu;
  const protectedText = text.replace(pattern, match => {
    const leading = match.startsWith('\n') ? '\n' : '';
    const literal = leading ? match.slice(1) : match;
    const token = `__CDT_${nonce}_${literals.length}__`;
    literals.push({ token, literal });
    return leading + token;
  });
  return {
    text: protectedText, literals,
    restore(translated) {
      let result = translated;
      for (const { token, literal } of literals) {
        if (result.split(token).length !== 2) throw new Error('Translation changed a protected literal');
        result = result.replace(token, () => literal);
      }
      return result;
    },
  };
}
