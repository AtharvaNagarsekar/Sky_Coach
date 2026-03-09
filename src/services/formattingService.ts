// ATC Formatting Service
// Uses Mistral to parse and format raw ATC transcriptions into structured entries

const MISTRAL_API_KEY = 'INDqptjgi4z3OuhLirbfPHCJnsrJrAVZ';
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
  confidence: number;    // 0–100
  flags: Array<{
    type: FlagType;
    description: string;
    severity: 'low' | 'medium' | 'high';
    confidence: number;
  }>;
  timestamp: Date;
  type: 'clearance' | 'readback' | 'information' | 'request' | 'correction' | 'other';
}

const SYSTEM_PROMPT = `You are an expert ATC (Air Traffic Control) communication analyst for Austin-Bergstrom International Airport (KAUS).

Given raw transcribed radio communication text, parse it into structured JSON.

Return a JSON array where each object represents ONE communication exchange with these fields:
{
  "speaker": "TOWER" | "APPROACH" | "DEPARTURE" | "GROUND" | "PILOT",
  "callsign": "<aircraft callsign or 'ATC' for controllers>",
  "facility": "<KAUS Tower / KAUS Approach / KAUS Departure / KAUS Ground> or null for pilots",
  "message": "<cleaned, ICAO-formatted message>",
  "confidence": <integer 0-100>,
  "type": "clearance" | "readback" | "information" | "request" | "correction" | "other",
  "flags": [
    {
      "type": "FALSE_READBACK" | "MISCOMMUNICATION" | "NON_STANDARD" | "READBACK_INCOMPLETE" | "WRONG_CALLSIGN",
      "description": "<what's wrong>",
      "severity": "low" | "medium" | "high",
      "confidence": <integer 0-100>
    }
  ]
}

Rules:
- If there's no clear speaker separation, guess based on context (ATC uses authority, pilots use callsign first)
- Do NOT correct false readbacks - flag them instead
- Maintain ICAO phraseology in the message field (expand: "two eight left" not "28L")
- Flag any non-standard phraseology
- Return ONLY valid JSON array, no markdown, no explanation`;

export async function formatATCTranscription(rawText: string, transcriptionConfidence: number): Promise<ATCEntry[]> {
  if (!rawText.trim() || rawText.length < 5) return [];

  try {
    const response = await fetch(MISTRAL_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${MISTRAL_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'mistral-large-latest',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `Transcription confidence: ${Math.round(transcriptionConfidence * 100)}%\n\nRaw transcription:\n${rawText}` },
        ],
        temperature: 0.1,
        max_tokens: 1500,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      console.error('Mistral formatting error:', response.status);
      return fallbackParse(rawText, transcriptionConfidence);
    }

    const data = await response.json();
    let content = data.choices?.[0]?.message?.content || '';

    // Parse JSON - handle wrapped objects
    try {
      const parsed = JSON.parse(content);
      const entries: any[] = Array.isArray(parsed) ? parsed : (parsed.entries || parsed.communications || [parsed]);

      return entries.map((e: any, i: number) => ({
        id: `${Date.now()}-${i}`,
        speaker: (e.speaker || 'UNKNOWN') as SpeakerType,
        callsign: e.callsign || 'UNKNOWN',
        facility: e.facility || undefined,
        message: e.message || rawText,
        rawMessage: rawText,
        confidence: Math.min(100, Math.max(0, Number(e.confidence) || Math.round(transcriptionConfidence * 80))),
        flags: (e.flags || []).map((f: any) => ({
          type: f.type,
          description: f.description,
          severity: f.severity || 'low',
          confidence: Number(f.confidence) || 70,
        })),
        timestamp: new Date(),
        type: e.type || 'other',
      }));
    } catch {
      return fallbackParse(rawText, transcriptionConfidence);
    }
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
