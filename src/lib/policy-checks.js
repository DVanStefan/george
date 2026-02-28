export function assertRequestAllowed(userRequest, policy) {
  const text = (userRequest || "").toLowerCase();
  const prohibited = policy.prohibitedUseCases || [];

  const checks = [
    {
      code: "illegal_activity",
      pattern: /\b(illegal|crime|fraud|evade|launder|hack)\b/,
      message: "Request appears to involve illegal activity.",
    },
    {
      code: "rights_infringement",
      pattern: /\b(copyright infringement|steal content|pirate)\b/,
      message: "Request appears to involve rights infringement.",
    },
    {
      code: "bullying_harassment_discrimination",
      pattern: /\b(harass|bully|discriminate|hate speech)\b/,
      message: "Request appears to involve bullying/harassment/discrimination.",
    },
    {
      code: "deception_or_manipulation",
      pattern: /\b(impersonate|deceive|manipulate|phishing)\b/,
      message: "Request appears to involve deception/manipulation.",
    },
    {
      code: "professional_judgment_decisions",
      pattern: /\b(final legal advice|medical diagnosis|licensed decision)\b/,
      message: "Request appears to require professional judgment decisions.",
    },
    {
      code: "employment_decisions",
      pattern:
        /\b(hire|fire|terminate|promotion decision|discipline employee|performance ranking)\b/,
      message: "Request appears to involve employment decisions.",
    },
  ];

  for (const check of checks) {
    if (!prohibited.includes(check.code)) {
      continue;
    }
    if (check.pattern.test(text)) {
      throw new Error(`Blocked by policy: ${check.message}`);
    }
  }
}

export function isQaPass(text) {
  const normalized = (text || "").toLowerCase();
  if (normalized.includes("pass/fail: pass")) return true;
  if (normalized.includes("decision: pass")) return true;
  if (normalized.includes("decision: fail")) return false;
  if (normalized.includes("pass/fail: fail")) return false;
  return false;
}
