import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config({ quiet: true });

export function createOpenAIClient() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY. Add it to .env.");
  }
  return new OpenAI({ apiKey });
}
