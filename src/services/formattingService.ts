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
// Strip all AI commentary, notes, and analysis from the spoken text.
function stripAnalysis(text: string): string {
  if (!text) return '';
  
  // 1. Hard Cut: If we see these markers, everything after is AI meta-talk. Delete it.
  const cutPoints = [
    /###/g, 
    /\*\*Validation:?\*\*/gi, /Validation:/gi,
    /\*\*Notes?:?\*\*/gi, /Notes?:/gi,
    /\*\*Analysis:?\*\*/gi, /Analysis:/gi,
    /Processing Notes?:/gi,
    /Confidence:/gi
  ];
  
  let cleaned = text;
  for (const regex of cutPoints) {
    const match = cleaned.split(regex);
    if (match.length > 1) cleaned = match[0]; // Take only the part before the marker
  }

  return cleaned
    .replace(/\s*\([^)]{10,}\)/g, '') // Remove any remaining parenthetical notes
    .replace(/\s*\(ATC[^)]*\)/gi, '')
    .replace(/\s*\(PILOT[^)]*\)/gi, '')
    .replace(/thank you for watching|thanks for watching/gi, '')
    .replace(/---|\*\*|\.\.\.|\*\*\*/g, '') // Remove clutter symbols
    .replace(/\[ATC\]|\[PILOT[^\]]*\]/gi, '') // Strip stray tags
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Lines that are Mistral meta-output, not actual radio transmissions
const META_LINE_PATTERNS = [
  /^here is/i, /^structured analysis/i, /^the following/i, /^processed output/i,
  /^transcript:/i, /^output:/i, /^analysis:/i, /^based on/i, /^validation/i,
  /^note:/i, /^\(confidence:/i, /^strictly follow/i, /^###/i,
];

function parsePlainTextOutput(text: string, rawInput: string, baseConfidence: number): ATCEntry[] {
  const entries: ATCEntry[] = [];
  
  // Pre-process: If Mistral put tags mid-paragraph, force them onto new lines
  const normalizedText = text
    .replace(/(\[ATC\])/gi, '\n$1')
    .replace(/(\[PILOT[^\]]*\])/gi, '\n$1');

  const lines = normalizedText.split('\n').map(l => l.trim()).filter(Boolean);

  let currentSpeaker: SpeakerType = 'UNKNOWN';
  let currentCallsign = 'UNKNOWN';
  let currentLines: string[] = [];
  let hasMiscomm = false;
  let pendingFlags: ATCEntry['flags'] = [];

  const flush = () => {
    if (currentLines.length === 0) return;
    
    // Join and apply the Nuclear Scrubber
    const joined = currentLines.join(' ');
    const message = stripAnalysis(joined);

    // Reject entries that are too short or purely symbolic
    if (!message || message.length < 3 || !/[a-zA-Z0-9]/.test(message)) {
      currentLines = [];
      return;
    }

    const lc = message.toLowerCase();
    let type: ATCEntry['type'] = 'other';
    let flags: ATCEntry['flags'] = [];

    if (currentSpeaker === 'PILOT') {
      type = 'readback';
      if (lc.includes('request') || lc.includes('able to') || lc.includes('would you')) type = 'request';
    } else {
      if (lc.includes('cleared') || lc.includes('descend') || lc.includes('climb') ||
        lc.includes('squawk') || lc.includes('heading') || lc.includes('contact')) type = 'clearance';
      else if (lc.includes('traffic') || lc.includes('wind') || lc.includes('precipitation') ||
        lc.includes('information') || lc.includes('expect')) type = 'information';
    }

    if (pendingFlags.length > 0) {
      flags = [...pendingFlags];
      pendingFlags = [];
    } else if (hasMiscomm) {
      flags.push({
        type: 'FALSE_READBACK',
        description: 'Discrepancy detected in transmission',
        severity: 'high',
        confidence: 80,
      });
      hasMiscomm = false;
    }

    if (currentSpeaker !== 'PILOT' && currentSpeaker !== 'UNKNOWN') {
      if (lc.includes('tower') || lc.includes('cleared to land') || lc.includes('cleared for takeoff') || lc.includes('line up')) {
        currentSpeaker = 'TOWER';
      } else if (lc.includes('departure') || (lc.includes('climb') && !lc.includes('tower'))) {
        currentSpeaker = 'DEPARTURE';
      } else if (lc.includes('ground') || lc.includes('taxi')) {
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
    // Process tags at the start of lines (after our normalization)
    if (/^\[ATC\]/i.test(line)) {
      flush();
      currentSpeaker = 'APPROACH';
      currentCallsign = 'ATC';
      const rest = line.replace(/^\[ATC\]/i, '').trim();
      if (rest) currentLines.push(rest);
      continue;
    }

    const pilotMatch = /^\[PILOT[\s–\-]+([^\]]+)\]/i.exec(line) || /^\[PILOT\]/i.exec(line);
    if (pilotMatch) {
      flush();
      currentSpeaker = 'PILOT';
      currentCallsign = pilotMatch[1]?.trim() || 'UNKNOWN';
      if (/^\d{3,5}$/.test(currentCallsign.replace(/\s/g, '')) ||
        currentCallsign.toLowerCase().includes('point') ||
        currentCallsign.toLowerCase() === 'unknown') {
        currentCallsign = 'UNKNOWN';
      }
      const rest = line.replace(/^\[PILOT[\s–\-]+[^\]]*\]/i, '').replace(/^\[PILOT\]/i, '').trim();
      if (rest) currentLines.push(rest);
      continue;
    }

    if (META_LINE_PATTERNS.some(p => p.test(line))) continue;

    const detailedFlagMatch = /^(?:⚠|POSSIBLE MISCOMM):?\s*\[([^\]]+)\]\s*(.*)/i.exec(line) ||
                             /^(?:⚠|POSSIBLE MISCOMM):?\s*(.*)/i.exec(line);
    if (detailedFlagMatch) {
      const desc = (detailedFlagMatch[2] || detailedFlagMatch[1] || '').toLowerCase();
      if (desc.includes('no discrepancies') || desc.includes('no error') || desc.includes('correct match')) {
        continue;
      }

      hasMiscomm = true;
      const typeStr = detailedFlagMatch[1]?.toUpperCase() || 'FALSE_READBACK';
      const type: FlagType = (typeStr.includes('CALLSIGN') ? 'WRONG_CALLSIGN' : 
                             typeStr.includes('INCOMPLETE') ? 'READBACK_INCOMPLETE' : 
                             'FALSE_READBACK') as FlagType;

      pendingFlags.push({
        type,
        description: (detailedFlagMatch[2] || detailedFlagMatch[1] || 'Discrepancy detected').trim(),
        severity: 'high',
        confidence: 85
      });
      continue;
    }

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

  const historyBlock = priorLines.length > 0
    ? `\nPREVIOUS HISTORY (FOR CONTEXT ONLY - DO NOT REPEAT THESE IN YOUR OUTPUT):\n${priorLines.slice(-4).map((l, i) => `${i + 1}. ${l}`).join('\n')}\n`
    : '';

  const prompt = `You are analyzing live ATC radio communication.
${historyBlock}

TASKS:
1. Split the "NEW RAW TRANSCRIPT" into [ATC] and [PILOT – Callsign] segments.
2. DIARIZATION STRATEGY: Aviation audio is typically a Clear Command -> Echo Readback.
   - If a phrase or instruction is repeated (e.g. "Runway 27... Runway 27"), split them. The second one is ALWAYS the [PILOT].
   - If a callsign appears at the end of a message (e.g. "...Southwest 321"), the preceding sentence belongs to that Pilot.
   - Separate segments at speaker switches: acknowledgments ("Roger", "Wilco"), tone shifts (Instruction to Repetition), or when "Sir/Ma'am" is used.
3. CLEAN TRANSCRIPT: Your [ATC] and [PILOT] output must contain ONLY the spoken words.
   - ⚠ CRITICAL: Do NOT include notes, corrections, explanations, or meta-talk inside the [ATC] or [PILOT] blocks.
4. VALIDATE READBACK: Compare the pilot's readback in the "NEW RAW TRANSCRIPT" against the instructions in "PREVIOUS HISTORY".
   - ⚠ RELAXATION: If a pilot reads back a number (Altitude, Heading, Runway, QNH, Squawk) that ATC issued in the "PREVIOUS HISTORY", it is CORRECT. 
   - NEVER flag it as "only referenced in history" — that is the primary point of a readback validation.
5. FLAG DISCREPANCIES: ONLY if you find a genuine MISMATCH or CONTRADICTION between history and readback.
   - ⚠ CRITICAL: If the readback matches the history, do NOT output a flag line.
   - ⚠ CRITICAL: Do NOT output "No discrepancies detected" or "Correct". 
 
STRICT DIARIZATION RULES:
- Example: "Southwest 321 cleared for takeoff cleared for takeoff southwest 321" 
  SHOULD BE: 
  [ATC] Southwest 321 cleared for takeoff.
  [PILOT - Southwest 321] Cleared for takeoff, southwest 321.

OUTPUT FORMAT:

[ATC]
The spoken words here.

[PILOT – Callsign]
The spoken words here.

⚠ [TYPE] Detailed description of what was wrong. (ONLY OUTPUT THIS IF THERE IS AN ACTUAL ERROR).

(Confidence: XX%)

STRICT REPETITION RULES:
1. ONLY process the transcript below.
2. NEVER re-output lines from history.

NEW RAW TRANSCRIPT TO PROCESS:
${rawText} (Analyze only this text, split ATC/Pilot if both are present)`;

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
