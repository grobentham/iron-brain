import baseHandler, { config } from './analyze.js';

export { config };

function upgradeUncertainty(items, architect) {
  const arr = Array.isArray(items) ? items.filter(Boolean) : [];
  const filtered = arr.filter(x => !/Synchronized NQ↔ES SMT remains fail-closed/i.test(String(x)));
  const smt = architect?.smt;
  if (smt) filtered.push(`Synchronized SMT was used only after native NQ/ES time alignment certification on ${smt.timeframe}; it is confluence, not an entry trigger by itself.`);
  else filtered.push('Synchronized NQ↔ES SMT is used only when same-timeframe charts have independently certified native time axes; otherwise it remains unavailable rather than guessed.');
  return filtered;
}

export default async function handler(req, res) {
  const originalJson = res.json.bind(res);
  res.json = body => {
    if (body?.ok && body?.result) {
      const architect = body.result.strategyArchitect || null;
      body.result.uncertainty = upgradeUncertainty(body.result.uncertainty, architect);
      body.result.marketContext = {
        synchronizedSMT: architect?.smt || null,
        multiTimeframe: architect?.mtf || null,
        dol: architect?.dol || null,
      };
    }
    if (body?.ok && body?.meta) {
      const architect = body.result?.strategyArchitect || null;
      body.meta.backendVersion = '6.3.0';
      body.meta.engine = 'native-perception-v4.2+time-axis-v6.1+synchronized-smt-v6.3+unified-mtf-market-model-v6.3+strategy-architect-v6.3';
      body.meta.strategyCreator = 'unified-mtf-market-graph-strategy-creator-v6.3';
      body.meta.synchronizedSMT = true;
      body.meta.smtCertifiedForCurrentRequest = Boolean(architect?.smt);
      body.meta.unifiedMultiTimeframeGraph = true;
      body.meta.rankedDOLEngine = true;
    }
    return originalJson(body);
  };
  return baseHandler(req, res);
}
