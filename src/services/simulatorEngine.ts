// Simulator Engine
// Manages ATC training sessions using Groq LLM with strict aviation format

const GROQ_API_KEY = import.meta.env.VITE_GROQ_API_KEY;
const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';

export type Situation =
  | 'parked' | 'pushback' | 'taxi_out' | 'departure' | 'climb'
  | 'cruise' | 'descend' | 'arrival' | 'hold' | 'taxi_in' | 'parked_gate'
  | 'emergency_weather' | 'emergency_medical' | 'emergency_traffic' | 'complete_flight'
  | 'custom';

export interface SituationConfig {
  label: string;
  group: string;
  atcSpeaksFirst: boolean;
  context: string;
}

export const SITUATIONS: Record<string, SituationConfig> = {
  parked: { label: 'Parked / Pre-Departure', group: 'Ground', atcSpeaksFirst: false, context: 'Aircraft parked at gate, pilot requesting ATIS and IFR clearance.' },
  pushback: { label: 'Pushback & Engine Start', group: 'Ground', atcSpeaksFirst: true, context: 'Ground control initiates pushback clearance.' },
  taxi_out: { label: 'Taxi to Runway', group: 'Ground', atcSpeaksFirst: false, context: 'Aircraft taxiing to assigned runway, following complex taxi instructions.' },
  departure: { label: 'Departure / Takeoff', group: 'Departure', atcSpeaksFirst: true, context: 'Tower clears aircraft for takeoff and initial departure instructions.' },
  climb: { label: 'Climb / Frequency Change', group: 'Departure', atcSpeaksFirst: true, context: 'Departure control issuing climb clearances and frequency changes.' },
  cruise: { label: 'Cruise / Center', group: 'En-Route', atcSpeaksFirst: true, context: 'Center control issuing altitude and routing amendments.' },
  descend: { label: 'Descent / Approach', group: 'En-Route', atcSpeaksFirst: true, context: 'Approach control issuing descent clearances and approach sequence.' },
  arrival: { label: 'Arrival / ILS', group: 'Arrival', atcSpeaksFirst: true, context: 'Approach vectoring pilot for ILS approach to KAUS.' },
  hold: { label: 'Holding Pattern', group: 'Arrival', atcSpeaksFirst: true, context: 'ATC issues holding instructions due to traffic.' },
  taxi_in: { label: 'Taxi to Gate', group: 'Arrival', atcSpeaksFirst: true, context: 'Ground control gives taxi to gate instructions after landing.' },
  parked_gate: { label: 'Shutdown at Gate', group: 'Arrival', atcSpeaksFirst: false, context: 'Pilot contacts ground to report at gate, final checks.' },
  emergency_weather: { label: 'Weather Deviation', group: 'Emergency', atcSpeaksFirst: false, context: 'Pilot declaring deviation from flight plan due to severe weather ahead, requesting new routing.' },
  emergency_medical: { label: 'Medical Emergency', group: 'Emergency', atcSpeaksFirst: false, context: 'Pilot declaring medical emergency on board, requesting priority handling and immediate landing.' },
  emergency_traffic: { label: 'Traffic Advisory / TCAS RA', group: 'Emergency', atcSpeaksFirst: true, context: 'TCAS resolution advisory. ATC issuing traffic alerts.' },
  complete_flight: { label: 'Complete Flight Simulation', group: 'Full Flight', atcSpeaksFirst: false, context: 'Full IFR flight from KAUS to KDFW. All phases from pre-departure clearance to taxi in.' },
};

export interface ConversationMessage {
  id: string;
  role: 'atc' | 'pilot';
  text: string;
  timestamp: Date;
  validation?: ReadbackValidation;
}

export interface ReadbackError {
  item: string;
  given: string;
  expected: string;
  category: 'callsign' | 'altitude' | 'heading' | 'frequency' | 'squawk' | 'speed' | 'runway' | 'phraseology' | 'other';
}

export interface ReadbackValidation {
  isCorrect: boolean;
  errors: ReadbackError[];
  correctReadback: string;
  score: number; // 0-100
  feedback: string;
}

export interface SessionStats {
  totalExchanges: number;
  correctReadbacks: number;
  errorsByCategory: Record<string, number>;
  commonMistakes: string[];
  weakestCategory: string; // Used by RL Engine
}

export function buildSessionContext(situation: Situation | string, callsign: string, customTopic = ''): string {
  const cfg = SITUATIONS[situation];
  const ctx = cfg ? cfg.context : customTopic;
  return `
Airport: Austin-Bergstrom International Airport (KAUS / AUS)
Active Runway: 18L/36R
ATIS: Information NOVEMBER. Wind 180 at 8 knots. Visibility 10 miles. Few clouds at 4,000. Temperature 22, Dew point 15. Altimeter 29.92. ILS approach runway 18L in use. Departure runway 36R.
Aircraft Callsign: ${callsign}
Aircraft Type: Boeing 737-800
Situation: ${ctx}
Current Phase: ${cfg ? cfg.label : customTopic}
`.trim();
}



const VALIDATION_SYSTEM_PROMPT = `You are an expert aviation radio communications instructor evaluating a pilot's readback against an ATC clearance.

Analyze the pilot's readback and return ONLY valid JSON with this structure:
{
  "isCorrect": boolean,
  "errors": [
    {
      "item": "what item was wrong",
      "given": "what pilot said",
      "expected": "what should have been said",
      "category": "callsign|altitude|heading|frequency|squawk|speed|runway|phraseology|other"
    }
  ],
  "correctReadback": "the complete correct readback in ICAO format",
  "score": <0-100 integer>,
  "feedback": "one concise sentence of instructor feedback"
}

Rules:
- Only flag ERRORS in readback (wrong values, missing items, wrong callsign)
- Do NOT penalize for slight wording variations that don't change meaning
- score = 100 if perfect, subtract 15 per error, minimum 0
- correctReadback should include callsign first, then all required items`;

export async function getATCResponse(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
): Promise<{ atcText: string; expectedReadback: string }> {
  const response = await fetch(GROQ_CHAT_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'meta-llama/llama-4-scout-17b-16e-instruct',
      messages,
      temperature: 0.3,
      max_tokens: 400,
    }),
  });

  if (!response.ok) throw new Error(`Groq API error: ${response.status}`);
  const data = await response.json();
  const content: string = data.choices?.[0]?.message?.content || '';

  // Split ATC call from expected readback
  const idx = content.indexOf('EXPECTED_READBACK:');
  if (idx !== -1) {
    return {
      atcText: content.slice(0, idx).trim(),
      expectedReadback: content.slice(idx + 'EXPECTED_READBACK:'.length).trim(),
    };
  }
  return { atcText: content.trim(), expectedReadback: '' };
}

const CHAIN_SYSTEM_PROMPT = `You are the ATC controller managing a single aircraft from pre-departure to parking at the destination.
Generate the NEXT logical ATC radio transmission based on the current flight phase and conversation history.

Output ONLY valid JSON:
{
  "flight_phase": "taxi|departure|climb|cruise|descend|approach|arrival|taxi_in|parked_gate",
  "atc_transmission": "The exact radio call you are making to the pilot",
  "expected_readback": "The exact readback expected from the pilot",
  "key_readback_items": ["item1", "item2"],
  "coaching_notes": "One brief tip for the user",
  "session_complete": false // set to true ONLY when parked at the gate at the end of the flight
}

* Keep your radio calls highly realistic, concise, and in standard ICAO phraseology.
* If the user just completed a readback perfectly, acknowledge and issue the next logical clearance.
* If the user made a mistake in the previous readback, correct them before issuing the next clearance.`;

export async function generateNextExchange(
  airportContext: string,
  callsign: string,
  difficulty: string,
  history: Array<{ role: 'pilot' | 'atc' | 'situation'; text: string; }>,
  scenarioType: string = 'Normal Traffic'
): Promise<{
  atc_transmission: string;
  expected_readback: string;
  key_readback_items: string[];
  coaching_notes: string;
  flight_phase: string;
  session_complete: boolean;
}> {
  // Convert custom history to OpenAI message format
  const messages = [
    { 
      role: 'system' as const, 
      content: `${CHAIN_SYSTEM_PROMPT}\n\nAirport Context:\n${airportContext}\nAircraft Callsign: ${callsign}\nDifficulty: ${difficulty}\nTraffic Level: ${scenarioType}` 
    },
    ...history.map(h => ({
      role: (h.role === 'pilot' ? 'user' : 'assistant') as 'system'|'user'|'assistant',
      content: h.role === 'situation' ? `[SITUATION BRIEFING]: ${h.text}` : h.text
    }))
  ];

  try {
    const response = await fetch(GROQ_CHAT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'meta-llama/llama-4-scout-17b-16e-instruct',
        messages,
        temperature: 0.4,
        response_format: { type: 'json_object' }
      }),
    });

    if (!response.ok) throw new Error('Groq API error in Chain Generation');
    const data = await response.json();
    const parsed = JSON.parse(data.choices?.[0]?.message?.content || '{}');

    return {
      atc_transmission: parsed.atc_transmission || '',
      expected_readback: parsed.expected_readback || '',
      key_readback_items: parsed.key_readback_items || [],
      coaching_notes: parsed.coaching_notes || '',
      flight_phase: parsed.flight_phase || 'cruise',
      session_complete: Boolean(parsed.session_complete)
    };
  } catch (e) {
    console.error("Chain processing failed", e);
    return {
      atc_transmission: `${callsign}, radar contact. Say intentions.`,
      expected_readback: '',
      key_readback_items: [],
      coaching_notes: 'Fallback generation triggered',
      flight_phase: 'cruise',
      session_complete: false
    };
  }
}

export async function validateReadback(
  atcClearance: string,
  pilotReadback: string,
  expectedReadback: string,
  callsign: string,
): Promise<ReadbackValidation> {
  try {
    const response = await fetch(GROQ_CHAT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'meta-llama/llama-4-scout-17b-16e-instruct',
        messages: [
          { role: 'system', content: VALIDATION_SYSTEM_PROMPT },
          {
            role: 'user',
            content: `Aircraft callsign: ${callsign}
ATC Clearance: ${atcClearance}
Expected readback: ${expectedReadback}
Pilot's actual readback: ${pilotReadback}`,
          },
        ],
        temperature: 0.1,
        max_tokens: 500,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) throw new Error('Validation API error');
    const data = await response.json();
    const parsed = JSON.parse(data.choices?.[0]?.message?.content || '{}');

    return {
      isCorrect: Boolean(parsed.isCorrect),
      errors: parsed.errors || [],
      correctReadback: parsed.correctReadback || expectedReadback,
      score: Math.min(100, Math.max(0, Number(parsed.score) || 0)),
      feedback: parsed.feedback || '',
    };
  } catch (e) {
    return { isCorrect: false, errors: [], correctReadback: expectedReadback, score: 0, feedback: 'Validation unavailable.' };
  }
}

export function aggregateStats(messages: ConversationMessage[]): SessionStats {
  const pilotMsgs = messages.filter(m => m.role === 'pilot' && m.validation);
  const correct = pilotMsgs.filter(m => m.validation?.isCorrect).length;
  const errorsByCategory: Record<string, number> = {};
  const mistakes: string[] = [];

  pilotMsgs.forEach(m => {
    m.validation?.errors.forEach(err => {
      errorsByCategory[err.category] = (errorsByCategory[err.category] || 0) + 1;
      if (!mistakes.includes(err.item)) mistakes.push(err.item);
    });
  });

  // Calculate weakest category for RL
  let weakest = 'None';
  let highestErrCount = 0;
  for (const [cat, count] of Object.entries(errorsByCategory)) {
    if (count > highestErrCount) {
      highestErrCount = count;
      weakest = cat;
    }
  }

  return {
    totalExchanges: pilotMsgs.length,
    correctReadbacks: correct,
    errorsByCategory,
    commonMistakes: mistakes.slice(0, 5),
    weakestCategory: weakest,
  };
}
