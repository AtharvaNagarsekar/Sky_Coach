// Transcription Service — Two-step pipeline:
//   1. Whisper (Groq) → raw audio-to-text with hallucination filtering
//   2. Groq Llama-4 → fast STT correction only (callsigns, numbers, phonetics)
//      Mistral Large handles speaker identification, splitting, and flagging.

const GROQ_API_KEY = import.meta.env.VITE_GROQ_API_KEY;
const GROQ_WHISPER_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';

export interface TranscriptionResult {
  text: string;
  confidence: number;
  duration?: number;
}

// ─── Airport context registry ─────────────────────────────────────────────────
export const AIRPORT_CONTEXTS: Record<string, string> = {
  KAUS: `Austin-Bergstrom International Airport (KAUS), Austin Texas USA.
Runways: 17L, 17R, 35L, 35R. Taxiways Alpha, Bravo, Charlie, Delta, Echo.
Frequencies: Tower 118.9, Approach 119.0, Departure 125.35, Ground 121.9, ATIS 135.9.
Common callsigns: Southwest SWA, American AAL, Delta DAL, United UAL, FedEx FDX, SkyWest SKW, Envoy ENY.
Standard altitudes: 3000, 4000, 5000, 6000, 8000 feet. Transition altitude FL180.`,

  WSSS: `Singapore Changi International Airport (WSSS), Singapore.
Runways: 02L, 02R, 20L, 20R. Taxiways A, B, C, D, E, F, W, S.
Frequencies: Approach 118.0, Departure 120.3, Tower 118.6, Ground 121.6.
Common callsigns: Singapore Airlines SIA, Scoot TGW, Jetstar JST, Cathay CPA, Emirates UAE.
Standard altitudes: 3000, 4000, 5000, 6000, FL100. QNH in hPa.`,

  EHAM: `Amsterdam Schiphol Airport (EHAM), Netherlands.
Runways: 18L, 18R, 36L, 36R, 27, 09, 06, 24.
Frequencies: Approach 119.055, Radar 120.2, Tower 118.1, Ground 121.8.
Common callsigns: KLM KLM, Transavia TRA, easyJet EZY, Ryanair RYR, Air France AFR, Lufthansa DLH.
Standard altitudes: 3000, 4000, 6000, FL60. QNH in hPa. Transition level FL60.`,

  YMML: `Melbourne Airport (YMML), Australia.
Runways: 16, 27, 34, 09. Taxiways Alpha, Bravo, Charlie, Delta.
Frequencies: Approach 130.0, Melbourne Centre 124.2, Tower 120.5, Ground 121.9.
Common callsigns: Qantas QFA, Virgin Australia VOZ, Jetstar JST, Rex RXA.
Standard altitudes: 3000, 5000, 7000 feet. QNH in hPa.`,
};

// ─── Step 1: Whisper raw transcription ───────────────────────────────────────
export async function transcribeAudio(
  audioBlob: Blob,
  _airportContext: string = '',
  _priorLines: string[] = [],
  isSimulator: boolean = false
): Promise<TranscriptionResult> {
  const whisperPrompt = isSimulator
    ? 'Pilot. Readback. Aviation radio. Niner. Tree. Fife. Roger. Wilco.'
    : 'ATC radio. Wilco. Roger. Affirm. Negative. Squawk four five two one. ' +
      'Cleared for takeoff. Hold short. Line up and wait. Descend and maintain four thousand. ' +
      'Niner. Two niner niner two. One seven left. Three five right. Radar contact.';

  const formData = new FormData();
  formData.append('file', audioBlob, 'audio.webm');
  formData.append('model', 'whisper-large-v3');
  formData.append('language', 'en');
  formData.append('response_format', 'verbose_json');
  formData.append('prompt', whisperPrompt);
  formData.append('temperature', '0');

  const response = await fetch(GROQ_WHISPER_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
    body: formData,
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Whisper error ${response.status}: ${err}`);
  }

  const data = await response.json();
  const rawText: string = data?.text || '';
  
  if (!rawText.trim()) {
    return { text: '', confidence: 0, duration: data?.duration || 0 };
  }

  // ── SIMULATOR BYPASS ───────────────────────────────────────────────────────
  // For the simulator, we want to hear EVERY word the pilot says, 
  // even if it's poor quality, noisy, or a short phrase like "Roger".
  if (isSimulator) {
    return { text: rawText, confidence: 0.9, duration: data?.duration || 0 };
  }

  // Layer 1: Whisper's own no_speech_prob (Live ATC only)
  if (data.segments?.length > 0) {
    const avgNoSpeech = data.segments.reduce(
      (s: number, seg: any) => s + (seg.no_speech_prob ?? 0), 0
    ) / data.segments.length;
    if (avgNoSpeech > 0.6) return { text: '', confidence: 0, duration: data.duration };
  }

  // Layer 2: Known hallucination patterns
  const normalized = rawText.trim().toLowerCase().replace(/[.,!?]/g, '');
  const words = normalized.split(/\s+/).filter(Boolean);
  const uniqueWords = new Set(words);

  if (words.length >= 2 && uniqueWords.size === 1)
    return { text: '', confidence: 0, duration: data.duration };

  const maxWordCount = words.length > 0
    ? Math.max(...Array.from(uniqueWords).map(w => words.filter(x => x === w).length))
    : 0;
  if (words.length > 3 && maxWordCount / words.length > 0.6)
    return { text: '', confidence: 0, duration: data.duration };

  const HALLUCINATION_PHRASES = new Set([
    'okay', 'ok', 'the', 'a', 'uh', 'um', 'hmm', 'hm', 'ah',
    'paper', 'thanks', 'thank you', 'you', 'yeah', 'yes', 'no',
    'bye', 'good bye', 'goodbye', 'hello', 'hi',
    'music', 'laughter', 'applause', 'silence',
    'subtitles by', 'transcribed by', 'www', 'http',
  ]);
  if (HALLUCINATION_PHRASES.has(normalized) || (words.length <= 1 && HALLUCINATION_PHRASES.has(words[0])))
    return { text: '', confidence: 0, duration: data.duration };

  // LAYER 3: Log-prob confidence
  let confidence = 0.75;
  if (data.segments?.length > 0) {
    const avgLogProb = data.segments.reduce(
      (s: number, seg: any) => s + (seg.avg_logprob ?? -0.5), 0
    ) / data.segments.length;
    confidence = Math.max(0.05, Math.min(1, Math.exp(avgLogProb) * 1.4));
    
    // Only apply the repetition penalty to Live ATC
    const uniqueRatio = uniqueWords.size / (words.length || 1);
    if (words.length > 4 && uniqueRatio < 0.4) confidence *= 0.2;
  }

  if (confidence < 0.12) return { text: '', confidence: 0, duration: data.duration };
  return { text: rawText, confidence, duration: data.duration };
}

// ─── Simulator-dedicated transcription (matches Python whisper_readback_widget) ──
// Step 1: Groq Whisper with aviation prompt → raw text
// Step 2: Mistral corrects phonetics using expected readback context
// NO hallucination filtering — every word the pilot says is valid training data.
export async function transcribeForSimulator(
  audioBlob: Blob,
  expectedReadback: string = '',
  callsign: string = ''
): Promise<{ rawText: string; correctedText: string }> {
  const result = await transcribeAudio(audioBlob, '', [], true);
  const rawText: string = result.text.trim();

  if (!rawText || result.confidence < 0.2) {
    return { rawText: '', correctedText: '' };
  }

  // Step 2: Mistral context-aware correction (same as Python's Mistral call)
  let correctedText = rawText;
  if (expectedReadback) {
    try {
      const corrected = await correctSimulatorReadback(rawText, expectedReadback, callsign);
      if (corrected) correctedText = corrected;
    } catch {
      correctedText = rawText; // Fall back to raw on error
    }
  }

  return { rawText, correctedText };
}

// ─── Phrase-level deduplication ───────────────────────────────────────────────
// Whisper and Groq sometimes repeat full sentences at end of chunks.
// e.g. "Speed your discretion. Field nine o'clock. Speed your discretion."
function dedupePhrases(text: string): string {
  // Split on sentence boundaries, keeping the delimiter
  const sentences = text.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
  if (sentences.length < 2) return text;

  const seen = new Set<string>();
  const unique: string[] = [];
  for (const s of sentences) {
    const key = s.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(s);
    }
  }
  return unique.join(' ');
}


// Groq's job is narrow: fix phonetic STT errors, airline callsigns, number pronunciation.
// Speaker identification is NOT done here — that's Mistral's job.
export async function refineTranscriptionWithGroq(
  rawText: string,
  airportIcao: string = 'KAUS',
  priorLines: string[] = []
): Promise<string> {
  if (!rawText.trim()) return rawText;

  const airportContext = AIRPORT_CONTEXTS[airportIcao.toUpperCase()] ||
    `${airportIcao} airport. Standard ATC radio communications.`;

  const historyBlock = priorLines.slice(-4).length > 0
    ? `\nKnown callsigns from recent transmissions: ${priorLines.slice(-4).join(' | ')}\n`
    : '';

  try {
    const response = await fetch(GROQ_CHAT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'meta-llama/llama-4-maverick-17b-128e-instruct',
        messages: [
          {
            role: 'system',
            content: `You are a fast ATC speech-to-text corrector. Fix transcription errors only.
${historyBlock}
AIRPORT: ${airportContext}

CORRECTION RULES (apply in order):
1. AIRLINE CALLSIGNS — fix STT mishears:
   "claw/clam/calm/claim" + number → "KLM [number]"
   "Sail/Segal/single/senior" + number → "Singapore [number]"
   Speedbird=British Airways | Cathay=Cathay Pacific | Emirates=Emirates
   American=American Airlines | Delta=Delta | United=United | Southwest=Southwest
   Citation/Cyprus → Citation (business jet)
   King Air/King Air → King Air | Caravan → Caravan | Kodiak → Kodiak
2. FLIGHT NUMBERS — always individual digits:
   "five hundred twenty-eight" → "five two eight"
   "twelve hundred" → "one two zero zero"
3. ICAO PRONUNCIATION: niner=9, tree=3, fife=5, zero=0
4. PHONETIC FIXES: "old short"→"hold short", "squab"→"squawk", "lined up"→"line up and wait", "cyprus"→"Citation"
5. NATO alphabet for runways/taxiways: November=N, Victor=V, etc.
6. DO NOT fix pilot readback errors — preserve them exactly as spoken
7. DO NOT add words not in the audio
8. If totally unintelligible, return: ""
9. DO NOT repeat phrases — if a sentence appears more than once, output it only once
10. OUTPUT: corrected text only — no labels, no explanation`,
          },
          { role: 'user', content: `Fix this STT output:\n${rawText}` },
        ],
        temperature: 0.05,
        max_tokens: 400,
      }),
    });

    if (!response.ok) {
      console.warn('Groq correction failed, using raw Whisper output');
      return rawText;
    }

    const data = await response.json();
    const corrected: string = data.choices?.[0]?.message?.content?.trim() || rawText;

    if (corrected === '') return '';

    // Safety: reject if model massively expanded (hallucination)
    if (corrected.length > rawText.length * 2.5 && rawText.length > 20) {
      console.warn('Groq correction rejected (over-expanded)');
      return rawText;
    }

    return dedupePhrases(corrected);
  } catch (err) {
    console.error('Groq correction error:', err);
    return rawText;
  }
}

// ─── Simulator Context-Aware Correction ──────────────────────────────────────
// Uses the expected readback to guide STT correction without cheating
export async function correctSimulatorReadback(
  rawText: string,
  expectedReadback: string,
  callsign: string
): Promise<string> {
  if (!rawText.trim() || !expectedReadback) return rawText;

  const prompt = `You are an STT correction AI for an ATC simulator.
The user's callsign is: ${callsign}.
They were expected to say something similar to: "${expectedReadback}"

The raw Whisper STT output was: "${rawText}"

Your job is to fix phonetic mishearings in the raw STT using the expected readback as context.
- DO NOT just copy the expected readback.
- ONLY fix obvious STT garble (e.g. "three five" instead of "tree fife", "radar" instead of "roger").
- If the user said something completely wrong, leave it wrong! We want to grade their mistakes.
- Remove trailing hallucinations like "We'll see you next time" or "Thanks for watching" if they are clearly not part of the aviation radio call.
- Output ONLY the corrected text.`;

  try {
    const response = await fetch(GROQ_CHAT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'meta-llama/llama-4-maverick-17b-128e-instruct',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens: 300,
      }),
    });

    if (!response.ok) return rawText;
    const data = await response.json();
    const corrected: string = data.choices?.[0]?.message?.content?.trim() || rawText;
    
    // Safety check - if it erased everything, return original
    if (corrected === '') return rawText;
    return corrected.replace(/^"|"$/g, '');
  } catch (e) {
    console.error("Contextual correction failed", e);
    return rawText;
  }
}
