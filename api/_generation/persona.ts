// Persona interview — the conversational style-discovery step of the wizard.
// Stateless: the client sends the running Q&A history + taste-picker selections +
// any reference-derived text; the server returns either the NEXT question or a
// final PersonaProfile. Cheap, low-token. No key → a scripted mock flow so the
// step works secret-free. The resulting profile is the single biggest driver of
// the generated deck's look (threaded into candidates + full generation).

import {
  PERSONA_TOOL,
  PERSONA_SCHEMA,
  coercePersonaStep,
  type PersonaInterviewRequest,
  type PersonaInterviewResponse,
  type PersonaInterviewState,
} from "../../shared/generation";
import { env, resolveProviders, callWithFallback, type Providers } from "./providers";

const MAX_QUESTIONS = 3;

const PERSONA_SYSTEM = `You are a warm, concise design-taste interviewer for an AI presentation generator. Your job is to learn the user's VISUAL style preferences (mood, color temperature, density, formality, motifs, references they admire) in as few questions as possible, then write a short profile.

Rules:
- Ask ONE short, friendly question at a time. Plain language, no jargon. Build on their previous answers.
- Ask at most ${MAX_QUESTIONS} questions total. As soon as you can characterize their taste, set done=true and write the profile — don't pad.
- The profile (profileText) is 2–4 sentences capturing mood, color temperature, density, formality, and any motifs/brands they like. referenceNote: one line on design DNA from their references, or empty.
- Always answer by calling the persona_step tool. Never write prose outside it.`;

export async function handlePersonaInterview(req: PersonaInterviewRequest): Promise<PersonaInterviewResponse> {
  const history = Array.isArray(req?.history) ? req.history.filter((h) => h && typeof h.q === "string" && typeof h.a === "string") : [];

  const forceMock = /^(1|true|yes|on)$/i.test(env("HTML_PPT_AI_MOCK") || "");
  const log: Record<string, unknown> = {};
  const providers: Providers = forceMock ? { primary: undefined, fallback: undefined } : resolveProviders(log);

  if (!providers.primary) {
    return { ...mockPersona(req, history), mock: true };
  }

  // Hard stop: if we've already asked the max, force a final profile.
  const forceDone = history.length >= MAX_QUESTIONS;
  const userText =
    `=== 주제 ===\n${req.topic ?? "(unspecified)"}\n\n` +
    `=== taste-picker 선택 ===\n${JSON.stringify(req.tastePicks ?? {}, null, 2)}\n\n` +
    `=== 참고자료에서 본 디자인 단서 ===\n${req.referenceText ?? "(none)"}\n\n` +
    `=== 지금까지의 문답 ===\n${history.length ? history.map((h, i) => `${i + 1}. Q: ${h.q}\n   A: ${h.a}`).join("\n") : "(none yet)"}\n\n` +
    (forceDone
      ? "이미 충분히 물었다. 반드시 done=true로 최종 프로필을 작성하라."
      : "다음 한 가지 질문을 하거나(done=false), 충분하면 done=true로 프로필을 작성하라.");

  try {
    const res = await callWithFallback(
      providers,
      {
        maxTokens: Number(env("HTML_PPT_PERSONA_MAX_TOKENS") || "2000"),
        images: [],
        userText,
        schema: PERSONA_SCHEMA,
        toolName: PERSONA_TOOL,
        toolDescription: "Return the next question, or the final persona profile when done.",
        system: PERSONA_SYSTEM,
      },
      log,
      "persona"
    );
    const step = coercePersonaStep(res.input);
    if (!step) return { ...mockPersona(req, history), mock: true };
    return { ...step, history, mock: false };
  } catch (err) {
    log.personaError = String((err as Error)?.message ?? err);
    return { ...mockPersona(req, history), mock: true };
  }
}

// --- mock ------------------------------------------------------------------

function mockPersona(req: PersonaInterviewRequest, history: Array<{ q: string; a: string }>): PersonaInterviewState {
  const scripted = [
    "What overall mood are you drawn to — warm & editorial, bold & dramatic, or clean & minimal?",
    "Light backgrounds or dark? And any colors you love (or want to avoid)?",
  ];
  if (history.length < scripted.length) {
    return { history, done: false, nextQuestion: scripted[history.length] };
  }
  const picks = req.tastePicks ?? {};
  const answers = history.map((h) => h.a).join(" ");
  const profileText =
    `Prefers a ${picks.mood ?? "refined"} look with ${picks.density ?? "balanced"} density and a ${picks.formality ?? "professional"} tone. ` +
    (answers ? `From the chat: ${answers.slice(0, 200)}.` : "Leans toward tasteful, modern presentation design.");
  return {
    history,
    done: true,
    profile: { profileText, referenceNote: req.referenceText ? "Design cues drawn from the user's references." : "" },
  };
}
