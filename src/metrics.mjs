const valid = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const completeTokens = t => t && [t.input,t.output,t.reasoning,t.cache?.read,t.cache?.write].every(valid);
export function summarize(messages, models = [], servers = [], session = null) {
  const measured = messages.filter(m => m.type === 'assistant' && completeTokens(m.tokens));
  const last = measured.at(-1);
  const model = models.find(m => m.providerID === last?.model.providerID && m.id === last?.model.id);
  const t = last?.tokens;
  const contextTokens = t ? t.input + t.output + t.reasoning + t.cache.read + t.cache.write : null;
  const timed = measured.filter(m => valid(m.time?.streamed) && valid(m.time?.completed) && m.time.completed > m.time.streamed).at(-1);
  let input = 0, cached = 0;
  for (const m of measured) { input += m.tokens.input + m.tokens.cache.read + m.tokens.cache.write; cached += m.tokens.cache.read; }
  const groups = new Map();
  for (const m of measured) {
    const key = `${m.model.providerID}/${m.model.id}`;
    const g = groups.get(key) || {...m.model, tokens:0};
    const t = m.tokens;
    g.tokens += t.input + t.output + t.reasoning + t.cache.read + t.cache.write;
    groups.set(key,g);
  }
  const total = [...groups.values()].reduce((sum,g) => sum + g.tokens,0);
  const mcps = servers.map(s => ({name:s.name, status:typeof s.status === 'string' ? s.status : s.status?.type || 'unknown',calls:0}));
  const longestFirst = [...mcps].sort((a,b) => b.name.length-a.name.length);
  for (const m of messages) for (const part of m.content || []) {
    if (part.type !== 'tool') continue;
    const nested = part.name === 'execute' && Array.isArray(part.state?.metadata?.toolCalls) ? part.state.metadata.toolCalls : [];
    for (const name of [part.name,...nested.map(c=>c.tool)]) {
      if (typeof name !== 'string') continue;
      const server = longestFirst.find(s => [s.name, s.name.replace(/[^\w-]/g,'_')].some(n => name.startsWith(n+'_') || name.startsWith(n+'.')));
      if (server) server.calls++;
    }
  }
  return {
    models: [...groups.values()].sort((a,b) => b.tokens-a.tokens).map(g => ({...g,percent:total ? g.tokens*100/total : null})),
    mcps,
    // Reported by the session itself. Never derived from token counts.
    sessionCost: valid(session?.cost) ? session.cost : null,
    contextTokens,
    contextLimit: model?.limit?.context || null,
    contextPercent: contextTokens !== null && model?.limit?.context > 0 ? contextTokens * 100 / model.limit.context : null,
    tokensPerSecond: timed ? (timed.tokens.output + timed.tokens.reasoning) * 1000 / (timed.time.completed - timed.time.streamed) : null,
    cachePercent: input > 0 ? cached / input * 100 : null,
  };
}
