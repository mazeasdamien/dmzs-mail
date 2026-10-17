/**
 * The writing assistant's line to Anthropic.
 *
 * Draft, Fix and Improve are the one place a message leaves Apple for anyone
 * else, and this file is all of that conversation: proving a key, listing what
 * it can reach, and asking for one rewrite. The routes in index.js decide when;
 * nothing here runs on its own.
 */
import Anthropic from "@anthropic-ai/sdk";

/**
 * What the assistant writes with until Settings or CLAUDE_MODEL says otherwise.
 *
 * Pinned rather than an alias, as the Gemini model before it was: an alias
 * moves under you, and the assistant would change behaviour on a morning
 * nothing here was touched.
 */
export const DEFAULT_MODEL = "claude-opus-5-5";

// Models that take `fallbacks: "default"`: a request their safety classifiers
// decline is run again on another model inside the same call, instead of
// coming back as a refusal with a draft on screen. Haiku has no server-side
// fallback and older models do not know the parameter, so it is only sent
// where it is understood.
const FALLBACK_MODELS = new Set([
  "claude-fable-5-1",
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-sonnet-5-5",
]);

// Someone is waiting on every call, mid-sentence. The SDK's defaults (ten
// minutes, two retries) would leave the composer spinning for half an hour on
// a bad day; one retry inside a minute and a half is the most worth waiting.
function client(key) {
  return new Anthropic({ apiKey: key, timeout: 90_000, maxRetries: 1 });
}

/** Anthropic's own words for what went wrong, rather than the SDK's wrapping of them. */
function reason(err) {
  // Before APIError, which it extends: no response means no message to quote.
  if (err instanceof Anthropic.APIConnectionError) return "could not reach Anthropic";
  if (err instanceof Anthropic.APIError) return err.error?.error?.message || `HTTP ${err.status}`;
  return String(err?.message || err);
}

/** Anthropic's verdict on a key: null when it works, the reason when it does not. */
export async function keyRefused(key) {
  try {
    await client(key).models.list({ limit: 1 });
    return null;
  } catch (err) {
    return reason(err);
  }
}

/**
 * Every model this key can write with, newest first, as Anthropic lists it.
 *
 * Only models that take `effort`: the request below is one shape for all of
 * them, and handing it to an older model is a 400 at the moment you press Fix
 * — which reads like the feature is broken rather than like the wrong model.
 */
export async function usableModels(key) {
  try {
    const models = [];
    for await (const m of client(key).models.list({ limit: 100 })) {
      if (m.capabilities?.effort?.supported) models.push(m.id);
    }
    return { models };
  } catch (err) {
    return { error: reason(err) };
  }
}

/**
 * One rewrite: the instruction as the system prompt, the draft (or the message
 * being answered) as the only user turn, and the text that comes back.
 *
 * `effort` stands where temperature used to. These models take no sampling
 * settings at all; how much thinking goes in is the dial instead, and it is
 * also the dial for how long you wait.
 */
export async function rewrite(key, model, { system, text, effort }) {
  let msg;
  try {
    msg = await client(key).beta.messages.create({
      model,
      // Thinking counts against this too, so it is room rather than a target:
      // an email is a few hundred tokens, and running out mid-sentence would
      // hand back half a reply.
      max_tokens: 16000,
      system,
      messages: [{ role: "user", content: text }],
      output_config: { effort },
      ...(FALLBACK_MODELS.has(model)
        ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" }
        : {}),
    });
  } catch (err) {
    return { error: reason(err) };
  }
  // Checked before the text is read: a refusal can arrive with part of an
  // answer in it, and half a reply is worse than none.
  if (msg.stop_reason === "refusal") return { error: "Claude declined to write this one" };
  if (msg.stop_reason === "max_tokens") return { error: "That ran out of room before it finished" };
  const out = msg.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  return out ? { text: out } : { error: "The model returned nothing usable" };
}
