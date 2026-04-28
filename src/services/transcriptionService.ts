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
  isSimulator: boolean = false,
  callsign: string = ''
): Promise<TranscriptionResult> {
  // Build a rich Whisper prompt that includes the exact callsign so the model
  // biases toward recognising it correctly (e.g. "6E431" or "November 1234 Alpha")
  const callsignHint = callsign ? `${callsign}, ` : '';

  const whisperPrompt = isSimulator
    ? `${callsignHint}ATC, pilot readback, niner, tree, fife, roger, wilco, affirm, negative, \
squawk, runway, heading, altitude, frequency, flight level, maintain, climb, descend, \
hold short, line up and wait, cleared for takeoff, cleared to land, contact, \
TCAS RA, TCAS advisory, traffic alert, ATIS, SID, STAR, ILS, VOR, DME, NDB, \
hold, outbound, inbound, radial, intersection, fix, waypoint, \
Alpha, Bravo, Charlie, Delta, Echo, Foxtrot, Golf, Hotel, India, Juliett, \
Kilo, Lima, Mike, November, Oscar, Papa, Quebec, Romeo, Sierra, Tango, \
Uniform, Victor, Whiskey, Xray, Yankee, Zulu`
    : 'ATC, live, radio, aviation, phraseology, niner, tree, fife, roger, wilco, affirm, negative, squawk, alpha, bravo, charlie, runway, flight, landing, takeoff, contact, maintaining, climb, descend, traffic';

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
    // Reject if too likely to be silence/static
    if (avgNoSpeech > 0.45) return { text: '', confidence: 0, duration: data.duration };
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
    'thank you for watching', 'thanks for watching', 'watching',
  ]);
  
  if (HALLUCINATION_PHRASES.has(normalized) || 
      (words.length <= 3 && words.some(w => HALLUCINATION_PHRASES.has(w))) ||
      /^[^a-zA-Z0-9]+$/.test(normalized)) { // Reject purely symbol lines
    return { text: '', confidence: 0, duration: data.duration };
  }

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
  const result = await transcribeAudio(audioBlob, '', [], true, callsign);
  const rawText: string = result.text.trim();

  if (!rawText || result.confidence < 0.2) {
    return { rawText: '', correctedText: '' };
  }

  // Step 2: LLM context-aware correction — ALWAYS runs.
  // Even with no expectedReadback, the model uses the callsign + aviation vocabulary
  // to fix STT errors (e.g. "6 echo 4 3 1" → "6E431", "tea class" → "TCAS RA").
  let correctedText = rawText;
  try {
    const corrected = await correctSimulatorReadback(rawText, expectedReadback, callsign);
    if (corrected) correctedText = corrected;
  } catch {
    correctedText = rawText; // Fall back to raw on error
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
        model: 'llama-3.3-70b-versatile',
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
  if (!rawText.trim() || !callsign) return rawText;

  // Build optional expected-readback context — if available it helps the model
  // identify what items should be present; if not, we rely on callsign + aviation vocab.
  const expectedContext = expectedReadback
    ? `EXPECTED READBACK (for context only — do NOT auto-insert missing items): "${expectedReadback}"`
    : `NO EXPECTED READBACK PROVIDED — use callsign and aviation knowledge only.`;

  // Expand the callsign into both compressed and phonetic forms so the model
  // can recognise any Whisper mishearing of it (e.g. "6E431" → "6E four three one",
  // or "November 1234 Alpha" for N1234A).
  const csExpanded = callsign
    .toUpperCase()
    .split('')
    .map(c => {
      const phonetic: Record<string,string> = {
        A:'Alpha',B:'Bravo',C:'Charlie',D:'Delta',E:'Echo',F:'Foxtrot',
        G:'Golf',H:'Hotel',I:'India',J:'Juliett',K:'Kilo',L:'Lima',
        M:'Mike',N:'November',O:'Oscar',P:'Papa',Q:'Quebec',R:'Romeo',
        S:'Sierra',T:'Tango',U:'Uniform',V:'Victor',W:'Whiskey',
        X:'X-ray',Y:'Yankee',Z:'Zulu'
      };
      return phonetic[c] ?? c;
    })
    .join(' ');

  const prompt = `You are an expert aviation radio communications STT correction AI.
AIRCRAFT CALLSIGN: "${callsign}" (phonetic: ${csExpanded})
${expectedContext}
RAW WHISPER OUTPUT: "${rawText}"

STRICT CORRECTION RULES:
1. CALLSIGN RECOGNITION: The aircraft callsign is "${callsign}". Whisper may have misheard it in
   many ways. Fix any phonetically similar mishearing back to "${callsign}".
   Examples of valid transcriptions of "${callsign}": ${csExpanded}, any digit-by-digit reading.
   Do NOT change the callsign to something else — just fix the spelling/spacing.

2. NATO PHONETIC ALPHABET (fix mishearings):
   Alpha=A, Bravo=B, Charlie=C, Delta=D, Echo=E, Foxtrot=F, Golf=G, Hotel=H,
   India=I, Juliett=J, Kilo=K, Lima=L, Mike=M, November=N, Oscar=O, Papa=P,
   Quebec=Q, Romeo=R, Sierra=S, Tango=T, Uniform=U, Victor=V, Whiskey=W,
   X-ray=X, Yankee=Y, Zulu=Z.
   Fix: "brave"→"Bravo", "echoes"→"Echo", "novel"→"November", "in the"→"India".

3. AVIATION PHRASEOLOGY (standardise STT mishearings):
   - "Roger", "Wilco", "Affirm", "Negative", "Unable"
   - "Cleared for takeoff", "Cleared to land", "Cleared ILS approach"
   - "Line up and wait" (NOT "lineup and wait" or "lined up wait")
   - "Hold short", "Hold position"
   - "Contact [facility] on [freq]", "Radar contact", "Radar service terminated"
   - "Maintain [altitude]", "Climb and maintain", "Descend and maintain"
   - "Fly heading [xxx]", "Turn left/right heading"
   - "Squawk [code]", "Squawk ident", "Stop squawk"
   - "Traffic in sight", "Negative traffic"

4. AVIATION SYSTEMS / ACRONYMS (fix Whisper mistranscriptions):
   - TCAS RA (Traffic Collision Avoidance System Resolution Advisory)
     → Whisper may say "tee cas" "t-cass" "tea class" — fix to "TCAS RA"
   - ATIS (Automatic Terminal Information Service)
   - SID (Standard Instrument Departure), STAR (Standard Terminal Arrival Route)
   - ILS (Instrument Landing System), VOR, DME, NDB, GPS, RNAV, RNP
   - QNH, QFE, altimeter setting
   - FIR (Flight Information Region), TMA (Terminal Manoeuvring Area)
   - PIREP (Pilot Report), SIGMET, METAR, TAF
   - FL (Flight Level) — "FL250" not "flight level to fifty"

5. NUMBER PRONUNCIATION:
   - Individual digits for callsigns & squawk codes: "6E431" → "6 Echo 4 3 1"
   - Altitudes: "8,000" → "eight thousand", FL250 → "flight level two five zero"
   - Headings: 270 → "two seven zero"
   - Frequencies: 119.4 → "one one niner decimal four"
   - Use "niner" for 9, "tree" for 3, "fife" for 5 where spoken that way.

6. PRESERVE ERRORS INTENTIONALLY MADE:
   If the pilot said the wrong number/runway (e.g., "runway two six" vs expected "two seven"),
   KEEP their error — only fix the transcription quality, not the content.

7. OUTPUT: corrected text ONLY — no labels, no explanation, no quotes.`;

  try {
    const response = await fetch(GROQ_CHAT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
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
