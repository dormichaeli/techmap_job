import { createHash } from "node:crypto";

const TITLE_SIGNALS = [
  [/user acquisition|\bua manager\b/i, 36, "title: user acquisition"],
  [/performance marketing/i, 36, "title: performance marketing"],
  [/\bppc\b|paid search|\bsem\b/i, 35, "title: paid search/PPC"],
  [/media buyer|media buying/i, 32, "title: media buying"],
  [/marketing (data )?analyst|marketing analytics/i, 35, "title: marketing analytics"],
  [/growth analyst|growth analytics/i, 32, "title: growth analytics"],
  [/acquisition analyst/i, 35, "title: acquisition analytics"],
  [/business (performance )?analyst/i, 26, "title: business analysis"],
  [/\bdata analyst\b|\bbi analyst\b|business intelligence analyst/i, 27, "title: data/BI analysis"],
  [/growth marketing/i, 29, "title: growth marketing"],
  [/marketing operations|marketing automation/i, 25, "title: marketing operations"],
  [/digital marketing/i, 24, "title: digital marketing"],
  [/\bmarketing\b/i, 10, "title: marketing"],
  [/\banalyst\b|analytics/i, 12, "title: analyst/analytics"],
];

const SKILL_SIGNALS = [
  [/google ads|adwords/i, 10, "skill: Google Ads"],
  [/microsoft ads|bing ads/i, 10, "skill: Microsoft/Bing Ads"],
  [/meta ads|facebook ads/i, 9, "skill: Meta Ads"],
  [/\bppc\b|paid search|paid media/i, 9, "skill: paid media"],
  [/user acquisition|customer acquisition/i, 9, "skill: acquisition"],
  [/marketing analytics|campaign analytics|growth analytics/i, 8, "skill: marketing/growth analytics"],
  [/\bsql\b/i, 7, "skill: SQL"],
  [/business intelligence|\bbi\b/i, 6, "skill: BI"],
  [/data analysis|analy[sz]e (large |complex )?data/i, 6, "skill: data analysis"],
  [/campaign optimization|roas|return on ad spend/i, 8, "skill: campaign optimization/ROAS"],
];

function locationScore(location, reasons) {
  const value = (location ?? "").toLowerCase();
  const central = /tel[ -]?aviv|herzliya|ramat gan|givatayim|petah tikva|bnei brak|holon|rishon|raanana|kfar saba|hod hasharon|kir[y|i]at ono|תל אביב|הרצליה|רמת גן|גבעתיים|פתח תקווה|בני ברק|חולון|ראשון|רעננה|כפר סבא|הוד השרון|קרית אונו/;
  if (central.test(value)) {
    reasons.push("location: central Israel");
    return 12;
  }
  if (/israel|ישראל|jerusalem|ירושלים|haifa|חיפה|netanya|נתניה/.test(value)) {
    reasons.push("location: Israel");
    return 6;
  }
  if (value && !/remote|global|worldwide|anywhere/.test(value)) {
    reasons.push("location: outside preferred region or unclear");
    return -25;
  }
  return 0;
}

export function scoreJob(job) {
  const title = job.job_title ?? "";
  const body = `${job.description ?? ""} ${job.department ?? ""}`;
  const combined = `${title} ${body}`;
  const reasons = [];
  let score = 0;

  for (const [pattern, points, reason] of TITLE_SIGNALS) {
    if (pattern.test(title)) {
      score += points;
      reasons.push(reason);
    }
  }
  let skillPoints = 0;
  for (const [pattern, points, reason] of SKILL_SIGNALS) {
    if (pattern.test(combined)) {
      skillPoints += points;
      reasons.push(reason);
    }
  }
  score += Math.min(skillPoints, 38);
  score += locationScore(job.location, reasons);

  const hasMarketingContext = /marketing|user acquisition|paid media|paid search|\bppc\b|google ads|meta ads|growth analytics/i.test(combined);
  if (/software|backend|frontend|full[ -]?stack|devops|site reliability|machine learning engineer|data engineer/i.test(title) && !hasMarketingContext) {
    score -= 40;
    reasons.push("penalty: engineering role without marketing context");
  }
  if (/account executive|sales representative|sales development|customer success/i.test(title) && !/analyst|operations/i.test(title)) {
    score -= 32;
    reasons.push("penalty: sales/customer-success role");
  }
  if (/product manager/i.test(title) && !/marketing/i.test(title)) {
    score -= 24;
    reasons.push("penalty: product management role");
  }
  if (/cyber|security|fraud|machine learning|\bml\b|big data/i.test(title) && !hasMarketingContext) {
    score -= 18;
    reasons.push("penalty: specialized non-marketing analytics domain");
  }
  if (/duty drawback|trade analyst|customs analyst|tax analyst/i.test(title)) {
    score -= 30;
    reasons.push("penalty: specialized trade/tax analysis outside target profile");
  }
  if (/chief|\bcmo\b|vice president|\bvp\b/i.test(title)) {
    score -= 20;
    reasons.push("penalty: executive seniority");
  }
  if (/\bremote\b/i.test(job.remote_type ?? job.location ?? "")) {
    score -= 3;
    reasons.push("preference: remote ranked below central onsite/hybrid");
  } else if (/hybrid/i.test(job.remote_type ?? body)) {
    score += 4;
    reasons.push("work arrangement: hybrid");
  }

  return {
    relevance_score: Math.max(0, Math.min(100, score)),
    relevance_reasons: [...new Set(reasons)].join("; ") || "No strong deterministic relevance signals",
  };
}

export function scoreDiscovery(job, company = {}, now = new Date()) {
  const reference = now instanceof Date ? now : new Date(now);
  const firstSeen = new Date(job.first_seen_at);
  const ageMs = reference.getTime() - firstSeen.getTime();
  const ageDays = Number.isFinite(ageMs) ? ageMs / 86_400_000 : Number.POSITIVE_INFINITY;
  const reasons = [];
  let score = 0;

  if (company.employee_size_evidence === "verified_within_10_200") {
    score += 30; reasons.push("company size: reported range within 10-200");
  } else if (company.employee_size_evidence === "overlaps_10_200") {
    score += 18; reasons.push("company size: reported range overlaps 10-200");
  } else if (company.employee_size_evidence === "unknown") {
    score += 4; reasons.push("company size: unknown, retained for review");
  } else {
    reasons.push("company size: outside preferred range");
  }
  if (/high|medium/i.test(company.employee_size_confidence ?? "")) {
    score += 5; reasons.push(`size confidence: ${company.employee_size_confidence}`);
  }
  if (Number(company.is_new_company) === 1) {
    score += 15; reasons.push("company: newly added to the project");
  }
  if (/martech|marketing|adtech|advertis|gaming|consumer|e-?commerce|mobile|subscription|saas|data|analytics/i.test(company.industry ?? "")) {
    score += 10; reasons.push("industry: target-adjacent");
  }
  if (ageDays <= 1) { score += 25; reasons.push("freshness: first discovered within 24 hours"); }
  else if (ageDays <= 7) { score += 20; reasons.push("freshness: first discovered within 7 days"); }
  else if (ageDays <= 30) { score += 8; reasons.push("freshness: first discovered within 30 days"); }
  else reasons.push("freshness: first discovered more than 30 days ago");

  if (/baseline/i.test(job.discovery_kind ?? "")) reasons.push("discovery: baseline import, not proof of new publication");
  return {
    discovery_priority_score: Math.max(0, Math.min(100, score)),
    discovery_priority_reasons: reasons.join("; "),
  };
}

export function normalizeJob(job, observedAt, context = {}) {
  const sourceIdentity = job.source_job_id || job.apply_url || job.job_url || `${job.job_title}|${job.location}`;
  const jobId = createHash("sha256")
    .update(`${job.source_provider}\u001f${job.company_name}\u001f${sourceIdentity}`)
    .digest("hex");
  const inferredRemote = job.remote_type
    ?? (/hybrid/i.test(`${job.location ?? ""} ${job.description ?? ""}`) ? "hybrid"
      : /remote/i.test(`${job.location ?? ""} ${job.description ?? ""}`) ? "remote" : null);
  const normalized = {
    job_id: jobId,
    source_job_id: String(sourceIdentity),
    company_name: job.company_name,
    job_title: job.job_title ?? null,
    location: job.location ?? null,
    remote_type: inferredRemote,
    department: job.department ?? null,
    description: job.description ?? null,
    job_url: job.job_url ?? null,
    apply_url: job.apply_url ?? null,
    source_provider: job.source_provider,
    source_url: job.source_url,
    first_seen_at: observedAt,
    last_seen_at: observedAt,
    source_updated_at: job.source_updated_at ?? null,
    published_at: job.published_at ?? null,
    published_at_source: job.published_at_source ?? null,
    company_id: context.company?.company_id ?? job.company_id ?? null,
    company_source_id: context.company?.company_source_id ?? job.company_source_id ?? null,
    first_seen_reliability: "collector_observed",
    discovery_cohort: context.discoveryCohort ?? "incremental",
    discovery_kind: context.discoveryKind ?? "new_to_collector",
    verification_status: "source_listed",
  };
  return {
    ...normalized,
    ...scoreJob(normalized),
    ...scoreDiscovery(normalized, context.company, observedAt),
    raw: job.raw,
  };
}
