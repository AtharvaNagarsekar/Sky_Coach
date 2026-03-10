// ATC Formatting Service
// Prompt architecture adopted from a working Python/Streamlit prototype.
// Mistral receives corrected transcript + conversation history,
// outputs structured [ATC] / [PILOT – Callsign] format which we parse into JSON.

const MISTRAL_API_KEY = import.meta.env.VITE_MISTRAL_API_KEY || 'INDqptjgi4z3OuhLirbfPHCJnsrJrAVZ';
const MISTRAL_URL = 'https://api.mistral.ai/v1/chat/completions';

export type SpeakerType = 'TOWER' | 'APPROACH' | 'DEPARTURE' | 'GROUND' | 'PILOT' | 'UNKNOWN';
export type FlagType = 'FALSE_READBACK' | 'MISCOMMUNICATION' | 'NON_STANDARD' | 'READBACK_INCOMPLETE' | 'WRONG_CALLSIGN';

export interface ATCEntry {
  id: string;
  speaker: SpeakerType;
  callsign: string;
  facility?: string;
  message: string;
  rawMessage: string;
  confidence: number;
  flags: Array<{
    type: FlagType;
    description: string;
    severity: 'low' | 'medium' | 'high';
    confidence: number;
  }>;
  timestamp: Date;
  type: 'clearance' | 'readback' | 'information' | 'request' | 'correction' | 'other';
}

// ─── Parse Mistral's [ATC] / [PILOT – Callsign] plain-text output into ATCEntry[] ──
// Strip parenthetical analysis commentary that Mistral sometimes adds to messages
function stripAnalysis(line: string): string {
  // Remove anything in (parens) that contains analysis keywords
  return line
    .replace(/\s*\([^)]{30,}\)/g, '') // long parenthetical notes
    .replace(/\s*\(ATC[^)]*\)/gi, '')  // (ATC did not issue...)
    .replace(/\s*\(Missing[^)]*\)/gi, '') // (Missing readback...)
    .replace(/\s*\(Note:[^)]*\)/gi, '')   // (Note: ...)
    .replace(/\s*\(This[^)]*\)/gi, '')    // (This appears to be...)
    .trim();
}

// Lines that are Mistral meta-output, not actual radio transmissions
const META_LINE_PATTERNS = [
  /^here is/i, /^structured analysis/i, /^the following/i,
  /^transcript:/i, /^output:/i, /^analysis:/i,
  /^note:/i, /^\(confidence:/i,
];

function parsePlainTextOutput(text: string, rawInput: string, baseConfidence: number): ATCEntry[] {
  const entries: ATCEntry[] = [];
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  let currentSpeaker: SpeakerType = 'UNKNOWN';
  let currentCallsign = 'UNKNOWN';
  let currentLines: string[] = [];
  let hasMiscomm = false;

  const flush = () => {
    if (currentLines.length === 0) return;
    // Join and strip any analysis commentary that slipped in
    const message = currentLines
      .map(stripAnalysis)
      .filter(l => l.length > 1)
      .join(' ')
      .trim();
    if (!message || message.length < 2) return;

    const lc = message.toLowerCase();
    let type: ATCEntry['type'] = 'other';
    let flags: ATCEntry['flags'] = [];

    if (currentSpeaker === 'PILOT') {
      type = 'readback';
      if (lc.includes('request') || lc.includes('able to') || lc.includes('would you')) type = 'request';
    } else {
      // ATC sub-type
      if (lc.includes('cleared') || lc.includes('descend') || lc.includes('climb') ||
        lc.includes('squawk') || lc.includes('heading') || lc.includes('contact')) type = 'clearance';
      else if (lc.includes('traffic') || lc.includes('wind') || lc.includes('precipitation') ||
        lc.includes('information') || lc.includes('expect')) type = 'information';
    }

    if (hasMiscomm) {
      flags.push({
        type: 'FALSE_READBACK',
        description: 'Possible mismatch between ATC instruction and pilot readback',
        severity: 'high',
        confidence: 80,
      });
      hasMiscomm = false;
    }

    // Determine ATC facility type
    if (currentSpeaker !== 'PILOT' && currentSpeaker !== 'UNKNOWN') {
      const m = lc;
      if (m.includes('tower') || m.includes('cleared to land') || m.includes('cleared for takeoff') || m.includes('line up')) {
        currentSpeaker = 'TOWER';
      } else if (m.includes('departure') || (m.includes('climb') && !m.includes('tower'))) {
        currentSpeaker = 'DEPARTURE';
      } else if (m.includes('ground') || m.includes('taxi')) {
        currentSpeaker = 'GROUND';
      }
    }

    entries.push({
      id: `${Date.now()}-${entries.length}`,
      speaker: currentSpeaker,
      callsign: currentSpeaker === 'PILOT' ? currentCallsign : 'ATC',
      message,
      rawMessage: rawInput,
      confidence: Math.max(20, Math.round(baseConfidence * 90)),
      flags,
      timestamp: new Date(),
      type,
    });

    currentLines = [];
  };

  for (const line of lines) {
    // Match [ATC] header
    if (/^\[ATC\]/i.test(line)) {
      flush();
      currentSpeaker = 'APPROACH'; // generic ATC — sub-typed during flush
      currentCallsign = 'ATC';
      const rest = line.replace(/^\[ATC\]/i, '').trim();
      if (rest) currentLines.push(rest);
      continue;
    }

    // Match [PILOT – Callsign] or [PILOT - Callsign] or [PILOT]
    const pilotMatch = /^\[PILOT[\s–\-]+([^\]]+)\]/i.exec(line) || /^\[PILOT\]/i.exec(line);
    if (pilotMatch) {
      flush();
      currentSpeaker = 'PILOT';
      currentCallsign = pilotMatch[1]?.trim() || 'UNKNOWN';
      // Sanitise: callsigns are airline names + numbers, not frequencies/altitudes/headings
      if (/^\d{3,5}$/.test(currentCallsign.replace(/\s/g, '')) ||
        currentCallsign.toLowerCase().includes('point') ||
        currentCallsign.toLowerCase() === 'unknown') {
        currentCallsign = 'UNKNOWN';
      }
      const rest = line.replace(/^\[PILOT[\s–\-]+[^\]]*\]/i, '').replace(/^\[PILOT\]/i, '').trim();
      if (rest) currentLines.push(rest);
      continue;
    }

    // Skip Mistral meta/intro lines (e.g. "Here is the structured analysis:")
    if (META_LINE_PATTERNS.some(p => p.test(line))) continue;

    // Miscomm flag line
    if (/POSSIBLE MISCOMM|⚠/i.test(line)) {
      hasMiscomm = true;
      continue;
    }

    // Confidence line — extract %
    const confMatch = /\(Confidence:\s*(\d+)%\)/i.exec(line);
    if (confMatch) continue; // skip — we use Whisper confidence directly

    // Skip separator lines
    if (/^[-=*]+$/.test(line)) continue;

    // Regular content line — append to current speaker
    currentLines.push(line);
  }

  flush();
  return entries;
}

// ─── Main: call Mistral with the proven simple prompt ─────────────────────────
export async function formatATCTranscription(
  rawText: string,
  transcriptionConfidence: number,
  priorLines: string[] = []
): Promise<ATCEntry[]> {
  if (!rawText.trim() || rawText.length < 5) return [];

  const contextBlock = priorLines.length > 0
    ? `\nRecent conversation context (use to identify active callsigns and expected readbacks):\n${priorLines.slice(-5).map((l, i) => `${i + 1}. ${l}`).join('\n')}\n`
    : '';

  const prompt = `You are analyzing live ATC radio communication.
${contextBlock}
PHRASEOLOGY INTELLIGENCE RULES:

- Messages starting with callsign followed by frequency/altitude are likely ATC.
- "Expect runway", "Cleared", "Descend and maintain", "Climb and maintain",
  "Turn left/right", "Contact", "Traffic" are typically ATC instructions.
- "With you", "Descending", "Climbing", "Cleared visual",
  repetition of altitude/runway/frequency is typically pilot readback.
- Callsign repeated at end is usually pilot readback.
- Traffic advisories, weather warnings, wind info = ALWAYS ATC, never pilot.
- Pilots commonly abbreviate frequencies (drop the leading "1") — this is NORMAL.

TASKS:

1. Split conversation into [ATC] and [PILOT – Callsign if identifiable]
2. Correct only obvious recognition errors.
3. Do NOT paraphrase or rewrite valid phraseology.
4. Compare ATC instructions vs pilot readbacks — check that KEY NUMBERS match.
5. ⚠ POSSIBLE MISCOMM when:
   • A NUMBER is WRONG (Altitude, Heading, Frequency, Squawk, Runway).
   • A CRITICAL number is MISSING (e.g. ATC gives altitude/runway, pilot forgets it).
   • The CALLSIGN is WRONG (ATC addressed Delta 1722, but a different pilot reads back).
   • The command is CONTRADICTORY (e.g. ATC says "Hold short", pilot says "Crossing").

   EXAMPLES OF FLAGS:
   • Runway number: ATC "one eight right" → pilot "one seven left" = FLAG
   • Missing Runway: ATC "cleared to land runway one eight right" → pilot "cleared to land" = FLAG
   • Altitude: ATC "four thousand" → pilot "three thousand" = FLAG
   • Heading: ATC "two eight zero" → pilot "two six zero" = FLAG
   • Frequency: ATC "one two one point zero" → pilot "one two zero point five" = FLAG

   PARAPHRASING THE SAME CLEARANCE IS NOT A FLAG:
   • ATC "cleared visual approach runway one eight right" → pilot "go for the visual one eight right" = CORRECT, no flag
   • ATC "contact tower one two one point zero" → pilot "over to tower one two one point zero" = CORRECT, no flag
   • ATC "traffic in sight" → pilot "got the American in sight" = CORRECT, no flag
   IF ALL NUMBERS AND THE CALLSIGN IN THE READBACK MATCH THE CLEARANCE → write nothing, no flag.


   NEVER FLAG THESE — they are normal, standard pilot speech:
   • "Good day" / "Good evening" / "Good morning" — informal but universally accepted closings
   • "We have info [letter]" / "Have info Lima" / "Information Alpha" — pilot proactively reporting ATIS received, NOT a readback
   • "With you" / "With you at [altitude]" — pilot check-in, always correct
   • Pilot reporting field/traffic in sight — proactive information, not a readback
   • Pilot saying "number two" / "number three" — position acknowledgement, not a readback error

6. If normal correct exchange → no flag.

CRITICAL MESSAGE RULES:
- Each message MUST contain ONLY the exact words spoken on the radio.
- Do NOT add parenthetical explanations, analysis, notes, or commentary inside or after a message.
- Do NOT explain why something is a flag — put only the spoken words in the message.
- Analysis and reasoning are FORBIDDEN in the output — only formatted radio speech.

CALLSIGN RULES:
- Callsigns are airline telephony names + flight numbers: "United 456", "Delta 1722", "Southwest 1851"
- Never use squawk codes, altitudes, headings, or frequencies as callsigns
- USE CONVERSATION HISTORY TO INFER CALLSIGNS:
  • If ATC just addressed "Delta 1722" and the next pilot response has no callsign stated, the pilot is still "Delta 1722"
  • If history shows only one active aircraft, all pilot transmissions belong to that aircraft
  • Only use "Unknown" if the callsign genuinely cannot be determined from text or history
- Pilots often drop callsign in short responses ("Roger", "We got the field in sight") — use history to fill in

OUTPUT FORMAT (strictly follow this structure):

[ATC]
Message here.

[PILOT – Callsign or Unknown]
Message here.

If another transmission follows, continue on new lines.
Do NOT put multiple speakers on the same line.

At end write:
(Confidence: XX%)

Transcript:
${rawText}`;

  try {
    const response = await fetch(MISTRAL_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${MISTRAL_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'mistral-large-latest',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens: 1200,
        // NOTE: no response_format: json_object — Mistral returns plain text which we parse
      }),
    });

    if (!response.ok) {
      console.error('Mistral error:', response.status, await response.text());
      return fallbackParse(rawText, transcriptionConfidence);
    }

    const data = await response.json();
    const content: string = data.choices?.[0]?.message?.content?.trim() || '';

    if (!content) return fallbackParse(rawText, transcriptionConfidence);

    const parsed = parsePlainTextOutput(content, rawText, transcriptionConfidence);
    return parsed.length > 0 ? parsed : fallbackParse(rawText, transcriptionConfidence);
  } catch (error) {
    console.error('Formatting service error:', error);
    return fallbackParse(rawText, transcriptionConfidence);
  }
}

function fallbackParse(rawText: string, confidence: number): ATCEntry[] {
  return [{
    id: `${Date.now()}-fallback`,
    speaker: 'UNKNOWN',
    callsign: 'UNKNOWN',
    message: rawText,
    rawMessage: rawText,
    confidence: Math.round(confidence * 60),
    flags: [],
    timestamp: new Date(),
    type: 'other',
  }];
}
