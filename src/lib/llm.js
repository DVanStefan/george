import { DEFAULT_MODEL } from "../constants.js";

export async function runModel({
  client,
  model = DEFAULT_MODEL,
  systemPrompt,
  userPrompt,
  temperature = 0.5,
}) {
  const response = await client.chat.completions.create({
    model,
    temperature,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });

  const content = response.choices[0]?.message?.content?.trim();
  if (!content) {
    throw new Error("Model returned empty content.");
  }
  return content;
}

export function extractDecision(text) {
  const normalized = text
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/\*\*/g, "")
    .replace(/`/g, "");

  const grab = (label) => {
    const pattern = new RegExp(
      `${label}:([\\s\\S]*?)(\\n[A-Za-z][A-Za-z ]+:|\\n---|$)`,
      "i"
    );
    const match = normalized.match(pattern);
    return match?.[1]?.trim() || "";
  };
  return {
    decision: grab("Decision"),
    rationale: grab("Rationale"),
    alternatives: grab("Alternatives considered"),
    confidence: grab("Confidence"),
    risks: grab("Risks"),
  };
}
