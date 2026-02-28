function extractJsonBlock(text) {
  const raw = (text || "").trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  return raw.slice(start, end + 1);
}

function normalizeSources(sources, allowedDomains) {
  const allow = new Set((allowedDomains || []).map((d) => d.toLowerCase()));
  const hasAllowlist = allow.size > 0;
  return (Array.isArray(sources) ? sources : [])
    .map((src, idx) => ({
      id: src?.id || `S${idx + 1}`,
      title: src?.title || "",
      url: src?.url || "",
      snippet: src?.snippet || "",
    }))
    .filter((src) => {
      if (!src.url) return false;
      if (!hasAllowlist) return true;
      try {
        const host = new URL(src.url).hostname.toLowerCase();
        return Array.from(allow).some((domain) => host === domain || host.endsWith(`.${domain}`));
      } catch {
        return false;
      }
    });
}

export async function maybeRunWebResearch({ client, policy, userRequest }) {
  if (!policy.webResearch?.enabled) {
    return { enabled: false, summary: "Web research disabled by policy.", sources: [] };
  }

  try {
    const response = await client.responses.create({
      model: policy.webResearch?.model || "gpt-4.1-mini",
      tools: [{ type: "web_search_preview" }],
      input: [
        {
          role: "system",
          content:
            "Find current, high-confidence factual context. Return JSON only: {\"summary\":\"...\",\"sources\":[{\"id\":\"S1\",\"title\":\"...\",\"url\":\"https://...\",\"snippet\":\"...\"}]}",
        },
        {
          role: "user",
          content: `Research this request for simulation planning: ${userRequest}`,
        },
      ],
    });

    const text = response.output_text?.trim() || "";
    const parsedBlock = extractJsonBlock(text);
    let parsed = { summary: text, sources: [] };
    if (parsedBlock) {
      try {
        parsed = JSON.parse(parsedBlock);
      } catch {
        parsed = { summary: text, sources: [] };
      }
    }
    const sources = normalizeSources(parsed.sources, policy.webResearch?.allowedDomains || []);
    return {
      enabled: true,
      summary: parsed.summary || "No web research text returned.",
      sources,
      citationRequired: policy.webResearch?.citationRequired === true,
    };
  } catch (err) {
    return {
      enabled: true,
      summary: `Web research failed: ${err.message}`,
      sources: [],
      citationRequired: policy.webResearch?.citationRequired === true,
    };
  }
}
