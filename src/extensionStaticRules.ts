export interface VigilStaticRuleSupport {
  ok: boolean;
  totalRules: number;
  regexRules: number;
  failedRules: Array<{ rulesetId: string; id: number; reason: string }>;
  error?: string;
}

export async function verifyVigilStaticRulesEnabled(api: typeof chrome): Promise<void> {
  const dnr = api.declarativeNetRequest;
  if (typeof dnr?.getEnabledRulesets !== "function" || typeof dnr.getDisabledRuleIds !== "function") {
    throw new Error("Required static-rule verification API is unavailable.");
  }
  const resources = api.runtime.getManifest().declarative_net_request?.rule_resources;
  if (!resources?.length || resources.some(resource => !resource.enabled)) throw new Error("Required static rulesets are missing or disabled in the manifest.");
  const enabled = await dnr.getEnabledRulesets();
  if (!Array.isArray(enabled) || resources.some(resource => !enabled.includes(resource.id))) throw new Error("Required static ruleset is not enabled.");
  for (const resource of resources) {
    const disabled = await dnr.getDisabledRuleIds({ rulesetId: resource.id });
    if (!Array.isArray(disabled) || disabled.length) throw new Error(`Static rules are disabled in ${resource.id}.`);
  }
}

// These are read-only DNR operations. No new permission, rule mutation, tab
// navigation or native-server request is involved in the compiler check.
export async function verifyVigilStaticRules(api: typeof chrome, read: typeof fetch = fetch): Promise<VigilStaticRuleSupport> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finished = false;
  const report: VigilStaticRuleSupport = { ok: false, totalRules: 0, regexRules: 0, failedRules: [] };
  const inspect = async () => {
    const dnr = api.declarativeNetRequest;
    if (typeof dnr?.isRegexSupported !== "function" || typeof dnr.getEnabledRulesets !== "function" || typeof dnr.getDisabledRuleIds !== "function") {
      throw new Error("Required static-rule verification API is unavailable.");
    }
    await verifyVigilStaticRulesEnabled(api);
    const resources = api.runtime.getManifest().declarative_net_request!.rule_resources!;
    for (const resource of resources) {
      const response = await read(api.runtime.getURL(resource.path));
      if (!response.ok) throw new Error(`Cannot read ${resource.path}.`);
      const rules: unknown = await response.json();
      if (!Array.isArray(rules) || !rules.length) throw new Error(`Empty or invalid ${resource.path}.`);
      report.totalRules += rules.length;
      const ids = new Set<number>();
      for (let start = 0; start < rules.length; start += 8) {
        if (finished) throw new Error("Static-rule verification timed out.");
        await Promise.all(rules.slice(start, start + 8).map(async (raw: unknown) => {
          if (!raw || typeof raw !== "object") throw new Error("Invalid static rule.");
          const rule = raw as chrome.declarativeNetRequest.Rule;
          if (!Number.isInteger(rule.id) || rule.id <= 0 || ids.has(rule.id) || !rule.condition || !rule.action) throw new Error("Invalid or duplicate static rule.");
          ids.add(rule.id);
          if (rule.condition.regexFilter === undefined) return;
          if (typeof rule.condition.regexFilter !== "string" || !rule.condition.regexFilter) throw new Error("Invalid static regex.");
          report.regexRules += 1;
          const result = await dnr.isRegexSupported({
            regex: rule.condition.regexFilter,
            // The API defaults to true; DNR conditions default to false.
            isCaseSensitive: rule.condition.isUrlFilterCaseSensitive === true,
            requireCapturing: rule.action.redirect?.regexSubstitution !== undefined
          });
          if (!result || result.isSupported !== true) {
            report.failedRules.push({ rulesetId: resource.id, id: rule.id, reason: result?.reason || "Invalid compiler response" });
          }
        }));
      }
    }
    await verifyVigilStaticRulesEnabled(api);
    report.failedRules.sort((left, right) => left.id - right.id);
    report.ok = report.failedRules.length === 0;
    if (!report.ok) report.error = "The browser rejected required static search protection.";
    return { ...report, failedRules: report.failedRules.map(rule => ({ ...rule })) };
  };
  try {
    return await Promise.race([
      inspect(),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Static-rule verification timed out.")), 5000); })
    ]);
  } catch (error) {
    return { ...report, failedRules: report.failedRules.map(rule => ({ ...rule })), ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally { finished = true; clearTimeout(timer); }
}
