import { createHash } from 'node:crypto';
import { LocalRuntime, modelId } from './local-runtime.mjs';
import { prepareTranslation, translationUnits, translationPrompt } from './context.mjs';

export { modelId };

export class OfflineTranslator {
  constructor({ runtime = new LocalRuntime() } = {}) {
    this.runtime = runtime;
    this.model = modelId;
    this.ready = null;
    this.cache = new Map();
    this.queue = Promise.resolve();
    this.used = false;
  }

  async load(target) {
    if (!['en', 'zh'].includes(target)) throw new Error('Target must be en or zh');
    if (!this.ready) {
      this.ready = this.runtime.post('/api/show', { model: modelId }).then(info => {
        if (info.remote_model || info.remote_host) throw new Error('Cloud models are not allowed for offline translation');
        return info;
      }).catch(error => { this.ready = null; throw error; });
    }
    return this.ready;
  }

  translate(text, target) {
    const task = this.queue.then(() => this.perform(text, target));
    this.queue = task.catch(() => {});
    return task;
  }

  async perform(text, target) {
    if (!['en', 'zh'].includes(target)) throw new Error('Target must be en or zh');
    if (typeof text !== 'string' || text.length > 30000) throw new Error('Text must be a string of at most 30000 characters');
    const key = createHash('sha256').update(`${modelId}\0${target}\0${text}`).digest('hex');
    if (this.cache.has(key)) return this.cache.get(key);
    const prepared = prepareTranslation(text);
    if (prepared.literal) return text;
    const needsTranslation = value => target === 'en' ? /\p{Script=Han}/u.test(value) : /[a-zA-Z]{2,}/.test(value);
    const units = translationUnits(prepared.text);
    let result = '', context = '';
    for (const unit of units) {
      if (unit.literal || !needsTranslation(prepared.prose(unit.text))) {
        result += unit.text;
        if (!unit.literal) context = unit.text;
        continue;
      }
      await this.load(target);
      const source = unit.text.trim();
      const response = await this.runtime.post('/api/chat', {
        model: modelId, stream: false, think: false, keep_alive: '1m',
        messages: [{ role: 'user', content: translationPrompt(source, target, context) }],
        options: { temperature: 0, num_ctx: 8192, num_predict: 4096, repeat_penalty: 1.05 },
      });
      this.used = true;
      if (response.done !== true || response.done_reason === 'length') throw new Error('Translation was incomplete; original text was not submitted.');
      const translated = response.message?.content?.trim();
      if (!translated || /<\/?think>/.test(translated)) throw new Error('Local model did not return a complete translation');
      prepared.validate(source, translated);
      result += unit.text.match(/^\s*/)[0] + translated + unit.text.match(/\s*$/)[0];
      context = unit.text;
    }
    const restored = prepared.restore(result);
    if (this.cache.size >= 256) this.cache.delete(this.cache.keys().next().value);
    this.cache.set(key, restored);
    return restored;
  }

  async dispose() {
    if (this.used) await this.runtime.post('/api/generate', { model: modelId, keep_alive: 0 }, 15000).catch(() => {});
  }
}
