// "New — AI Deck" wizard. A chip/card-driven flow that follows the enriched
// pipeline: Topic → Persona (taste + Q&A + references) → Format → Sample (3
// one-slide candidates to pick/regenerate) → Details + Files (title, detail, and
// uploads parsed server-side for text + images) → Review → Generate. On Generate
// it POSTs every answer (incl. the picked candidate's locked style as a seed) to
// /api/generate and hands the result back to the app. Inputs persist on error.

import { useState, useEffect, type ChangeEvent } from "react";
import {
  DECK_PRESET_INFO,
  DECK_FORMAT_INFO,
  DECK_AUDIENCES,
  DECK_LENGTHS,
  DECK_LANGUAGES,
  DECK_THREE_D,
  MAX_UPLOADS,
  MAX_UPLOAD_BYTES,
  type DeckPreset,
  type DeckFormat,
  type DeckAudience,
  type DeckLength,
  type DeckLanguage,
  type DeckThreeD,
  type PersonaProfile,
  type GenerationRequest,
  type GenerationUpload,
  type GeneratedDeck,
  type PromptExport,
  type CandidateResult,
} from "@shared/generation";
import { formatUsage } from "@shared/generation";
import { requestGeneration, requestCandidates, personaInterview, parseUpload, loadGeneratedDeck } from "../ai/generate-client";
import { logger, downloadLogs } from "../lib/logger";
import { SparkleIcon } from "./icons";

interface Props {
  onClose: () => void;
  onGenerated: (deck: GeneratedDeck) => void;
}

const STEPS = ["Topic", "Persona", "Format", "Sample", "Details", "Review"] as const;
type StepId = (typeof STEPS)[number];

const STEP_META: Record<StepId, { title: string; subtitle: string }> = {
  Topic: { title: "What's your deck about?", subtitle: "One line is enough — the AI handles the rest." },
  Persona: { title: "Your style", subtitle: "This drives the whole look. Pick a vibe, answer a few questions, or show us references." },
  Format: { title: "What kind of deck?", subtitle: "How it should behave and read." },
  Sample: { title: "Pick a direction", subtitle: "Three sample slides. Choose one — or regenerate." },
  Details: { title: "Title & materials", subtitle: "Add a title, any detail, and files to draw from." },
  Review: { title: "Ready to generate", subtitle: "Review your choices and add any final direction." },
};

const GEN_STAGES = [
  "Designing the layout…",
  "Writing the slides…",
  "Building charts & visuals…",
  "Composing the 3D background…",
  "Self-checking & polishing…",
  "Almost there…",
];

function fmtElapsed(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

const AUDIENCE_LABEL: Record<DeckAudience, string> = {
  auto: "Auto",
  academic: "Academic",
  investor: "Investor",
  executive: "Executive",
  general: "General",
  consumer: "Consumer / MZ",
};
const LENGTH_LABEL: Record<DeckLength, string> = {
  auto: "Auto (≈12 min)",
  short: "Short",
  standard: "Standard",
  long: "Long",
};
const LANGUAGE_LABEL: Record<DeckLanguage, string> = { auto: "Auto", ko: "한국어", en: "English" };
const THREE_D_LABEL: Record<DeckThreeD, string> = { auto: "Auto", none: "None", on: "Use 3D" };
const FORMAT_LABEL: Record<DeckFormat, string> = { auto: "Auto", interactive: "Interactive", presentation: "Presentation", document: "Document" };

// Taste-picker questions (the quick, deterministic part of persona discovery).
const TASTE: Array<{ key: string; label: string; options: string[] }> = [
  { key: "mood", label: "Mood", options: ["Warm & editorial", "Bold & dramatic", "Clean & minimal", "Playful & vivid"] },
  { key: "background", label: "Background", options: ["Light", "Dark"] },
  { key: "density", label: "Density", options: ["Airy", "Balanced", "Dense"] },
  { key: "formality", label: "Tone", options: ["Professional", "Friendly", "Academic"] },
];

const PERSONA_LS_KEY = "slidesmith.persona";

function loadSavedPersona(): { picks: Record<string, string>; profileText: string } | null {
  try {
    const raw = localStorage.getItem(PERSONA_LS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function fileKind(f: File): GenerationUpload["kind"] {
  if (f.type.startsWith("image/")) return "image";
  if (/\.(csv|tsv|json|xml|xlsx?|txt|md)$/i.test(f.name) || /text|json|csv/.test(f.type)) return "data";
  return "reference";
}

function readAsDataUrl(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(r.error);
    r.onload = () => resolve(String(r.result));
    r.readAsDataURL(f);
  });
}

function readAsText(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(r.error);
    r.onload = () => resolve(String(r.result));
    r.readAsText(f);
  });
}

const PARSE_EXT = /\.(pdf|docx?)$/i;

export function NewDeckWizard({ onClose, onGenerated }: Props) {
  const [step, setStep] = useState(0);
  const [dir, setDir] = useState(1);
  const goto = (next: number) => {
    setError(null);
    setDir(next > step ? 1 : -1);
    setStep(next);
  };

  const [topic, setTopic] = useState("");
  const [preset, setPreset] = useState<DeckPreset>("auto");
  const [format, setFormat] = useState<DeckFormat>("auto");
  const [audience, setAudience] = useState<DeckAudience>("auto");
  const [length, setLength] = useState<DeckLength>("auto");
  const [language, setLanguage] = useState<DeckLanguage>("auto");
  const [threeD, setThreeD] = useState<DeckThreeD>("auto");

  // Persona
  const [tastePicks, setTastePicks] = useState<Record<string, string>>({});
  const [personaText, setPersonaText] = useState("");
  const [references, setReferences] = useState<GenerationUpload[]>([]);
  // Conversational interview state
  const [qaHistory, setQaHistory] = useState<Array<{ q: string; a: string }>>([]);
  const [qaQuestion, setQaQuestion] = useState<string | null>(null);
  const [qaAnswer, setQaAnswer] = useState("");
  const [qaBusy, setQaBusy] = useState(false);

  // Sample candidates
  const [candidates, setCandidates] = useState<CandidateResult[] | null>(null);
  const [candBusy, setCandBusy] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);

  // Details
  const [title, setTitle] = useState("");
  const [detailText, setDetailText] = useState("");
  const [uploads, setUploads] = useState<GenerationUpload[]>([]);
  const [parsing, setParsing] = useState(false);

  const [extraPrompt, setExtraPrompt] = useState("");
  const [advanced, setAdvanced] = useState(false);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<GeneratedDeck | null>(null);

  // Prefill persona from the reusable per-user profile.
  useEffect(() => {
    const saved = loadSavedPersona();
    if (saved) {
      setTastePicks(saved.picks ?? {});
      setPersonaText(saved.profileText ?? "");
    }
  }, []);

  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!busy) {
      setElapsed(0);
      return;
    }
    const t = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(t);
  }, [busy]);
  const stageIdx = Math.min(Math.floor(elapsed / 6), GEN_STAGES.length - 1);

  const stepId = STEPS[step];
  const canNext = step > 0 || topic.trim().length > 0;

  const buildPersona = (): PersonaProfile | undefined => {
    const profileText = personaText.trim();
    const hasPicks = Object.keys(tastePicks).length > 0;
    if (!profileText && !hasPicks && !references.length) return undefined;
    const refNote = references.length ? `User provided ${references.length} reference file(s): ${references.map((r) => r.name).join(", ")}.` : undefined;
    return { tastePicks: hasPicks ? tastePicks : undefined, profileText: profileText || undefined, referenceNote: refNote };
  };

  // --- persona interview ---------------------------------------------------
  const referenceText = (): string =>
    references.length ? `References: ${references.map((r) => r.name).join(", ")}.` : "";

  const startOrContinueInterview = async (answer?: string) => {
    setQaBusy(true);
    setError(null);
    try {
      const history = answer && qaQuestion ? [...qaHistory, { q: qaQuestion, a: answer }] : qaHistory;
      const res = await personaInterview({ history, tastePicks, referenceText: referenceText(), topic: topic.trim() });
      setQaHistory(res.history.length ? res.history : history);
      if (res.done && res.profile) {
        setQaQuestion(null);
        setPersonaText((res.profile.profileText || "").trim());
        logger.info("wizard", "Persona profile inferred");
      } else if (res.nextQuestion) {
        setQaQuestion(res.nextQuestion);
      } else {
        setQaQuestion(null);
      }
      setQaAnswer("");
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    } finally {
      setQaBusy(false);
    }
  };

  // --- file handling -------------------------------------------------------
  const addReferenceFiles = async (e: ChangeEvent<HTMLInputElement>) => {
    const list = Array.from(e.target.files ?? []);
    e.target.value = "";
    const next = [...references];
    for (const f of list) {
      if (next.length >= MAX_UPLOADS) break;
      if (f.size > MAX_UPLOAD_BYTES) {
        setError(`"${f.name}" is larger than ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB and was skipped.`);
        continue;
      }
      try {
        // References are style-only: images go in as "reference" (vision, not placed).
        const dataUrl = f.type.startsWith("image/") ? await readAsDataUrl(f) : undefined;
        next.push(dataUrl ? { name: f.name, mime: f.type, kind: "reference", dataUrl } : { name: f.name, mime: f.type, kind: "reference", text: (await readAsText(f)).slice(0, 4000) });
      } catch (err) {
        logger.warn("wizard", `Failed to read reference ${f.name}`, String((err as Error)?.message ?? err));
      }
    }
    setReferences(next);
  };

  const addContentFiles = async (e: ChangeEvent<HTMLInputElement>) => {
    const list = Array.from(e.target.files ?? []);
    e.target.value = "";
    setParsing(true);
    const next = [...uploads];
    for (const f of list) {
      if (next.length >= MAX_UPLOADS) {
        setError(`You can attach at most ${MAX_UPLOADS} files.`);
        break;
      }
      if (f.size > MAX_UPLOAD_BYTES) {
        setError(`"${f.name}" is larger than ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB and was skipped.`);
        continue;
      }
      try {
        if (PARSE_EXT.test(f.name) || /pdf|wordprocessingml|msword/.test(f.type)) {
          // pdf / docx → server extracts text + embedded images.
          const dataUrl = await readAsDataUrl(f);
          const parsed = await parseUpload({ name: f.name, mime: f.type, dataUrl });
          if (parsed.text) next.push({ name: f.name, mime: "text/plain", kind: "data", text: parsed.text });
          parsed.images.slice(0, 6).forEach((img, i) => {
            if (next.length < MAX_UPLOADS) next.push({ name: `${f.name} · image ${i + 1}`, mime: "image/png", kind: "image", dataUrl: img });
          });
          logger.info("wizard", `Parsed ${f.name}`, { textChars: parsed.text.length, images: parsed.images.length });
        } else if (f.type.startsWith("image/")) {
          next.push({ name: f.name, mime: f.type, kind: "image", dataUrl: await readAsDataUrl(f) });
        } else {
          next.push({ name: f.name, mime: f.type, kind: fileKind(f), text: (await readAsText(f)).slice(0, 12000) });
        }
      } catch (err) {
        setError(`Couldn't read "${f.name}": ${String((err as Error)?.message ?? err)}`);
        logger.warn("wizard", `Failed to read upload ${f.name}`, String((err as Error)?.message ?? err));
      }
    }
    setUploads(next);
    setParsing(false);
  };

  // --- candidates ----------------------------------------------------------
  const generateCandidates = async () => {
    setCandBusy(true);
    setError(null);
    setPicked(null);
    try {
      const res = await requestCandidates({
        topic: topic.trim(),
        title: title.trim() || undefined,
        preset,
        format,
        audience,
        language,
        persona: buildPersona(),
        count: 3,
      });
      setCandidates(res.candidates);
      logger.info("wizard", `Got ${res.candidates.length} candidates`, { mock: res.mock });
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    } finally {
      setCandBusy(false);
    }
  };

  const pickedCandidate = (): CandidateResult | undefined => candidates?.find((c) => c.candidateId === picked);

  // --- generate ------------------------------------------------------------
  const generate = async () => {
    setBusy(true);
    setError(null);
    // Persist persona for reuse next time.
    try {
      if (Object.keys(tastePicks).length || personaText.trim())
        localStorage.setItem(PERSONA_LS_KEY, JSON.stringify({ picks: tastePicks, profileText: personaText.trim() }));
    } catch {
      /* non-fatal */
    }
    const cand = pickedCandidate();
    const req: GenerationRequest = {
      topic: topic.trim(),
      title: title.trim() || undefined,
      preset,
      format,
      persona: buildPersona(),
      candidateSeed: cand ? { brief: cand.brief, styleCss: cand.css } : undefined,
      audience,
      length,
      language,
      threeD,
      detailByStep: detailText.trim() ? { Details: detailText.trim() } : undefined,
      extraPrompt: extraPrompt.trim() || undefined,
      uploads: [...uploads, ...references],
    };
    logger.info("wizard", "Generation requested", { topic: req.topic, preset, format, audience, length, language, threeD, uploads: req.uploads?.length, seeded: !!cand });
    try {
      const deck = await requestGeneration(req);
      logger.info("wizard", `Generated ${deck.deckId}`, { mock: deck.mock, usage: deck.usage });
      setDone(deck);
      setBusy(false);
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      logger.error("wizard", "Generation failed", msg);
      setError(msg);
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal wizard" role="dialog" aria-modal="true">
        <div className="wizard-top">
          <div className="wizard-brand">
            <SparkleIcon /> AI Deck
          </div>
          <div className="wizard-progress" aria-hidden="true">
            {STEPS.map((s, i) => (
              <span key={s} className={`wizard-seg${i <= step ? " on" : ""}`} />
            ))}
          </div>
        </div>

        {busy ? (
          <div className="wizard-busy">
            <div className="spinner" />
            <div className="wizard-busy-title">
              Generating
              <span className="wizard-dots" aria-hidden="true">
                <i>.</i>
                <i>.</i>
                <i>.</i>
              </span>
            </div>
            <div className="wizard-busy-stage" key={stageIdx}>
              {GEN_STAGES[stageIdx]}
            </div>
            <div className="wizard-busy-sub">This usually takes a minute or two — keep this open.</div>
            <div className="wizard-busy-time" aria-hidden="true">
              {fmtElapsed(elapsed)}
            </div>
          </div>
        ) : done && done.promptExport ? (
          <PromptExportView promptExport={done.promptExport} onGenerated={onGenerated} />
        ) : done ? (
          <div className="wizard-busy wizard-done">
            <div className="wizard-done-check" aria-hidden="true">
              ✓
            </div>
            <div className="wizard-busy-title">{done.mock ? "Demo deck ready" : "Deck ready"}</div>
            <div className="wizard-done-msg">{done.message}</div>
            <div className="wizard-done-usage">
              {done.usage
                ? `${formatUsage(done.usage)} · ${done.usage.provider}${done.usage.costUsd == null ? " · cost n/a" : " (estimated)"}`
                : done.mock
                  ? "Demo mode — no tokens used."
                  : "Token usage unavailable."}
            </div>
            <button className="primary" onClick={() => onGenerated(done)}>
              Open deck
            </button>
          </div>
        ) : (
          <div className="wizard-body">
            <div className={`wizard-anim ${dir >= 0 ? "fwd" : "back"}`} key={step}>
              <div className="wizard-hero">
                <h2>{STEP_META[stepId].title}</h2>
                <p>{STEP_META[stepId].subtitle}</p>
              </div>

              {stepId === "Topic" && (
                <div className="wizard-step">
                  <input
                    className="wizard-input"
                    autoFocus
                    placeholder='e.g. "울산 영세 요식업 데이터 컨설팅" / "B2B HR SaaS Series A pitch"'
                    value={topic}
                    onChange={(e) => setTopic(e.target.value)}
                  />
                  <Detail value={detailText} onChange={setDetailText} placeholder="Anything specific to cover, emphasize, or avoid? (optional)" />
                </div>
              )}

              {stepId === "Persona" && (
                <div className="wizard-step">
                  {TASTE.map((t) => (
                    <div key={t.key}>
                      <label className="wizard-label">{t.label}</label>
                      <div className="wizard-chips">
                        {t.options.map((o) => (
                          <button
                            key={o}
                            className={`wizard-chip${tastePicks[t.key] === o ? " active" : ""}`}
                            onClick={() => setTastePicks((p) => ({ ...p, [t.key]: p[t.key] === o ? "" : o }))}
                          >
                            {o}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}

                  <div className="wizard-persona-qa">
                    {qaQuestion ? (
                      <>
                        <div className="wizard-persona-q">{qaQuestion}</div>
                        <textarea
                          className="wizard-textarea"
                          placeholder="Your answer…"
                          value={qaAnswer}
                          onChange={(e) => setQaAnswer(e.target.value)}
                        />
                        <button className="wizard-advanced" disabled={qaBusy || !qaAnswer.trim()} onClick={() => startOrContinueInterview(qaAnswer.trim())}>
                          {qaBusy ? "Thinking…" : "Next"}
                        </button>
                      </>
                    ) : personaText ? (
                      <div className="wizard-persona-profile">
                        <b>Your style</b>
                        <p>{personaText}</p>
                        <button className="linklike" onClick={() => { setQaHistory([]); setPersonaText(""); startOrContinueInterview(); }}>
                          Redo questions
                        </button>
                      </div>
                    ) : (
                      <button className="wizard-advanced" disabled={qaBusy} onClick={() => startOrContinueInterview()}>
                        {qaBusy ? "Thinking…" : "✨ Help me find my style (answer a few questions)"}
                      </button>
                    )}
                  </div>

                  <label className="wizard-label">References you like (optional)</label>
                  <Uploads uploads={references} onFiles={addReferenceFiles} onRemove={(i) => setReferences(references.filter((_, k) => k !== i))} accept="image/*,.pdf,.txt,.md" hint="images · decks you admire" />
                </div>
              )}

              {stepId === "Format" && (
                <div className="wizard-step">
                  <div className="wizard-cards">
                    <Card active={format === "auto"} onClick={() => setFormat("auto")} title="Auto" hint="Let AI choose from the topic" />
                    {(Object.keys(DECK_FORMAT_INFO) as Array<Exclude<DeckFormat, "auto">>).map((k) => (
                      <Card key={k} active={format === k} onClick={() => setFormat(k)} title={DECK_FORMAT_INFO[k].label} hint={DECK_FORMAT_INFO[k].hint} />
                    ))}
                  </div>
                  <label className="wizard-label">Visual preset</label>
                  <div className="wizard-cards">
                    <Card active={preset === "auto"} onClick={() => setPreset("auto")} title="Auto" hint="From your topic & persona" />
                    {(Object.keys(DECK_PRESET_INFO) as Array<Exclude<DeckPreset, "auto">>).map((k) => (
                      <Card key={k} active={preset === k} onClick={() => setPreset(k)} title={DECK_PRESET_INFO[k].label} hint={DECK_PRESET_INFO[k].hint} />
                    ))}
                  </div>
                </div>
              )}

              {stepId === "Sample" && (
                <div className="wizard-step">
                  {!candidates ? (
                    <div className="wizard-sample-empty">
                      <p>Generate three sample title slides shaped by your topic, persona, and format. Pick the one you like — it seeds the full deck.</p>
                      <button className="primary" disabled={candBusy} onClick={generateCandidates}>
                        {candBusy ? "Designing samples…" : "✨ Generate 3 samples"}
                      </button>
                      <button className="linklike" onClick={() => goto(step + 1)}>
                        Skip — let AI decide
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className="wizard-candidates">
                        {candidates.map((c) => (
                          <button
                            key={c.candidateId}
                            className={`wizard-candidate${picked === c.candidateId ? " active" : ""}`}
                            onClick={() => setPicked(c.candidateId)}
                          >
                            <iframe className="wizard-candidate-frame" title={c.label} srcDoc={c.html} sandbox="allow-same-origin" tabIndex={-1} />
                            <span className="wizard-candidate-label">{c.label}{picked === c.candidateId ? " ✓" : ""}</span>
                          </button>
                        ))}
                      </div>
                      <button className="wizard-advanced" disabled={candBusy} onClick={generateCandidates}>
                        {candBusy ? "Regenerating…" : "↻ Regenerate samples"}
                      </button>
                    </>
                  )}
                </div>
              )}

              {stepId === "Details" && (
                <div className="wizard-step">
                  <label className="wizard-label">Title</label>
                  <input className="wizard-input" placeholder="Deck title (defaults to your topic)" value={title} onChange={(e) => setTitle(e.target.value)} />
                  <label className="wizard-label">Detail</label>
                  <textarea className="wizard-textarea" placeholder="Key points, data, structure — anything to ground the content (optional)" value={detailText} onChange={(e) => setDetailText(e.target.value)} />
                  <label className="wizard-label">Source files</label>
                  <Uploads uploads={uploads} onFiles={addContentFiles} onRemove={(i) => setUploads(uploads.filter((_, k) => k !== i))} accept="image/*,.pdf,.doc,.docx,.csv,.tsv,.json,.xml,.txt,.md" hint="pdf · docx · images · data" busy={parsing} />
                  {parsing && <div className="wizard-parsing">Extracting text & images…</div>}
                </div>
              )}

              {stepId === "Review" && (
                <div className="wizard-step">
                  <ul className="wizard-summary">
                    <li><b>Topic</b><span>{topic.trim() || "—"}</span></li>
                    <li><b>Title</b><span>{title.trim() || "(from topic)"}</span></li>
                    <li><b>Format</b><span>{FORMAT_LABEL[format]}</span></li>
                    <li><b>Preset</b><span>{preset === "auto" ? "Auto" : DECK_PRESET_INFO[preset as Exclude<DeckPreset, "auto">].label}</span></li>
                    <li><b>Persona</b><span>{personaText ? "Profiled" : Object.keys(tastePicks).length ? "Taste set" : "—"}</span></li>
                    <li><b>Sample</b><span>{pickedCandidate() ? pickedCandidate()!.label : "AI decides"}</span></li>
                    <li><b>Audience</b><span>{AUDIENCE_LABEL[audience]}</span></li>
                    <li><b>Length</b><span>{LENGTH_LABEL[length]}</span></li>
                    {uploads.length > 0 && <li><b>Files</b><span>{uploads.length} attached</span></li>}
                  </ul>
                  <button className="wizard-advanced" onClick={() => setAdvanced((a) => !a)}>
                    {advanced ? "− Fewer options" : "+ More options"}
                  </button>
                  {advanced && (
                    <>
                      <label className="wizard-label">Audience</label>
                      <Chips options={DECK_AUDIENCES} value={audience} label={(v) => AUDIENCE_LABEL[v]} onChange={setAudience} />
                      <label className="wizard-label">Length</label>
                      <Chips options={DECK_LENGTHS} value={length} label={(v) => LENGTH_LABEL[v]} onChange={setLength} />
                      <label className="wizard-label">Language</label>
                      <Chips options={DECK_LANGUAGES} value={language} label={(v) => LANGUAGE_LABEL[v]} onChange={setLanguage} />
                      <label className="wizard-label">3D background</label>
                      <Chips options={DECK_THREE_D} value={threeD} label={(v) => THREE_D_LABEL[v]} onChange={setThreeD} />
                    </>
                  )}
                  <label className="wizard-label">Anything else to add?</label>
                  <textarea className="wizard-textarea" placeholder="Final instructions for the AI (optional)" value={extraPrompt} onChange={(e) => setExtraPrompt(e.target.value)} />
                </div>
              )}
            </div>
          </div>
        )}

        {error && (
          <div className="wizard-error">
            <span>{error}</span>
            <button className="linklike" onClick={downloadLogs} title="Download logs for a bug report">
              Download logs
            </button>
          </div>
        )}

        {!busy && !done && (
          <div className="actions wizard-actions">
            <button onClick={onClose}>Cancel</button>
            <span className="spacer" />
            {step > 0 && <button onClick={() => goto(step - 1)}>Back</button>}
            {step < STEPS.length - 1 ? (
              <button className="primary" disabled={!canNext} onClick={() => goto(step + 1)}>
                Continue
              </button>
            ) : (
              <button className="primary" disabled={!topic.trim()} onClick={generate}>
                Generate deck
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// Prompt-export mode (HTML_PPT_AI_MOCK=1): instead of a generated deck, the user
// gets the exact prompt to paste into a Claude Code session. After Claude Code
// writes the deck to generated/<deckId>/, "Load it" pulls it back in.
function PromptExportView({ promptExport, onGenerated }: { promptExport: PromptExport; onGenerated: (deck: GeneratedDeck) => void }) {
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(promptExport.prompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setErr("Copy failed — select the text and copy manually.");
    }
  };
  const load = async () => {
    setLoading(true);
    setErr(null);
    try {
      onGenerated(await loadGeneratedDeck(promptExport.deckId));
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
      setLoading(false);
    }
  };

  return (
    <div className="wizard-busy wizard-done wizard-export">
      <div className="wizard-busy-title">Generate with Claude Code</div>
      <div className="wizard-done-msg">
        Copy this prompt into a Claude Code session in this project. It writes the deck to <code>{promptExport.dir}/</code> following <code>{promptExport.docPath}</code>. When it finishes, click <strong>Load it</strong>.
      </div>
      <textarea
        className="wizard-textarea wizard-export-prompt"
        readOnly
        value={promptExport.prompt}
        rows={10}
        onFocus={(e) => e.currentTarget.select()}
      />
      <div className="actions wizard-actions">
        <button onClick={copy}>{copied ? "Copied ✓" : "Copy prompt"}</button>
        <span className="spacer" />
        <button className="primary" onClick={load} disabled={loading}>
          {loading ? "Loading…" : "Load it"}
        </button>
      </div>
      {err && <div className="wizard-error">{err}</div>}
    </div>
  );
}

function Detail({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  const [open, setOpen] = useState(false);
  if (!open && !value) return <button className="wizard-advanced" onClick={() => setOpen(true)}>+ Describe in more detail</button>;
  return <textarea className="wizard-textarea" placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />;
}

function Card({ active, onClick, title, hint }: { active: boolean; onClick: () => void; title: string; hint: string }) {
  return (
    <button className={`wizard-card${active ? " active" : ""}`} onClick={onClick}>
      <span className="wizard-card-title">{title}</span>
      <span className="wizard-card-hint">{hint}</span>
    </button>
  );
}

function Chips<T extends string>({ options, value, label, onChange }: { options: readonly T[]; value: T; label: (v: T) => string; onChange: (v: T) => void }) {
  return (
    <div className="wizard-chips">
      {options.map((o) => (
        <button key={o} className={`wizard-chip${value === o ? " active" : ""}`} onClick={() => onChange(o)}>
          {label(o)}
        </button>
      ))}
    </div>
  );
}

function Uploads({
  uploads,
  onFiles,
  onRemove,
  accept,
  hint,
  busy,
}: {
  uploads: GenerationUpload[];
  onFiles: (e: ChangeEvent<HTMLInputElement>) => void;
  onRemove: (i: number) => void;
  accept: string;
  hint: string;
  busy?: boolean;
}) {
  return (
    <div className="wizard-uploads">
      <label className="wizard-upload-btn">
        + Attach files <span className="menu-dim">{hint}</span>
        <input type="file" multiple hidden accept={accept} onChange={onFiles} disabled={busy} />
      </label>
      {uploads.length > 0 && (
        <ul className="wizard-upload-list">
          {uploads.map((u, i) => (
            <li key={i}>
              <span className="wizard-upload-kind">{u.kind}</span>
              <span className="wizard-upload-name">{u.name}</span>
              <button className="linklike" onClick={() => onRemove(i)}>
                remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
