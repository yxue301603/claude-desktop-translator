import path from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { protectLiterals } from './literals.mjs';

export const modelIds = { en: 'Xenova/opus-mt-zh-en', zh: 'Xenova/opus-mt-en-zh' };
export const modelCache = path.join(homedir(), '.claude-desktop-translator', 'offline-models');

export function literalSegments(text) {
  if (/^\s*[\[{]/.test(text)) {
    try { JSON.parse(text); return [{ text, literal: true }]; } catch { /* prose */ }
  }
  const protectedText = protectLiterals(text);
  const literals = new Map(protectedText.literals.map(item => [item.token, item.literal]));
  const matches = [...protectedText.text.matchAll(/__CDT_[a-f0-9]+_\d+__/g)];
  const segments = [];
  let offset = 0;
  for (const match of matches) {
    if (match.index > offset) segments.push({ text: protectedText.text.slice(offset, match.index), literal: false });
    segments.push({ text: literals.get(match[0]), literal: true });
    offset = match.index + match[0].length;
  }
  if (offset < protectedText.text.length) segments.push({ text: protectedText.text.slice(offset), literal: false });
  return segments;
}

export function splitProse(text, maxLength = 220) {
  const result = [];
  for (const line of text.split(/(\r?\n)/)) {
    if (/^\r?\n$/.test(line)) { result.push({ text: line, literal: true }); continue; }
    const match = /^(\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)?)([\s\S]*?)(\s*)$/.exec(line);
    if (match[1]) result.push({ text: match[1], literal: true });
    let content = match[2];
    while (content.length > maxLength) {
      const candidate = content.slice(0, maxLength);
      const punctuation = Math.max(candidate.lastIndexOf('。') + 1, candidate.lastIndexOf('！') + 1, candidate.lastIndexOf('？') + 1, candidate.lastIndexOf('. ') + 1, candidate.lastIndexOf(' '));
      const cut = punctuation > maxLength / 3 ? punctuation : maxLength;
      result.push({ text: content.slice(0, cut), literal: false });
      content = content.slice(cut);
    }
    if (content) result.push({ text: content, literal: false });
    if (match[3]) result.push({ text: match[3], literal: true });
  }
  return result;
}

export class OfflineTranslator {
  constructor({ cacheDir = modelCache, download = false, createPipeline } = {}) {
    this.cacheDir = cacheDir;
    this.download = download;
    this.createPipeline = createPipeline;
    this.pipelines = new Map();
    this.cache = new Map();
    this.queue = Promise.resolve();
  }

  async load(target) {
    if (!modelIds[target]) throw new Error('Target must be en or zh');
    if (!this.pipelines.has(target)) {
      this.pipelines.set(target, (async () => {
        let createPipeline = this.createPipeline;
        if (!createPipeline) {
          const { pipeline, env } = await import('@huggingface/transformers');
          env.cacheDir = this.cacheDir;
          env.allowRemoteModels = this.download;
          env.allowLocalModels = true;
          env.backends.onnx.logLevel = 'error';
          createPipeline = pipeline;
        }
        return createPipeline('translation', modelIds[target], {
          dtype: 'q8', device: 'cpu', cache_dir: this.cacheDir,
          local_files_only: !this.download,
          session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 },
        });
      })().catch(error => { this.pipelines.delete(target); throw error; }));
    }
    return this.pipelines.get(target);
  }

  translate(text, target) {
    const task = this.queue.then(() => this.perform(text, target));
    this.queue = task.catch(() => {});
    return task;
  }

  async perform(text, target) {
    if (!modelIds[target]) throw new Error('Target must be en or zh');
    if (typeof text !== 'string' || text.length > 30000) throw new Error('Text must be a string of at most 30000 characters');
    const key = createHash('sha256').update(`${target}\0${text}`).digest('hex');
    if (this.cache.has(key)) return this.cache.get(key);
    const needsTranslation = value => target === 'en' ? /\p{Script=Han}/u.test(value) : /[a-zA-Z]{2,}/.test(value);
    const segments = literalSegments(text).flatMap(segment => segment.literal ? [segment] : splitProse(segment.text, target === 'en' ? 180 : 600));
    let output = '';
    for (const segment of segments) {
      if (segment.literal || !needsTranslation(segment.text)) { output += segment.text; continue; }
      const leading = segment.text.match(/^\s*/)[0];
      const trailing = segment.text.match(/\s*$/)[0];
      const source = segment.text.trim();
      const commonWords = { Run: '运行', Open: '打开', Done: '完成', Note: '注意' };
      if (target === 'zh' && commonWords[source]) { output += leading + commonWords[source] + trailing; continue; }
      const pipe = await this.load(target);
      const result = await pipe(source, { max_new_tokens: 384, num_beams: 2, do_sample: false, no_repeat_ngram_size: 3 });
      const translated = result[0]?.translation_text?.trim();
      if (!translated) throw new Error('Offline model returned no translation');
      output += leading + translated + trailing;
    }
    if (this.cache.size >= 256) this.cache.delete(this.cache.keys().next().value);
    this.cache.set(key, output);
    return output;
  }

  async dispose() {
    for (const pipe of this.pipelines.values()) await (await pipe).dispose?.();
  }
}
