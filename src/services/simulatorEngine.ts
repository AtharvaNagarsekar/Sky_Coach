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

// Phase-specific ATC rules injected into the system context.
// Tells the LLM what is and is not appropriate for each scenario phase.
const PHASE_RULES: Record<string, string> = {
  parked: `
GROUND PHASE RULES (aircraft is parked at gate, engines off):
- NEVER mention altitude — aircraft is on the ground.
- ATC/Clearance delivery issues IFR clearance: route, squawk code, initial altitude, departure frequency.
- ALTITUDE RULES: Use "FL100" for 10,000ft and above (e.g. "FL120", "FL180"). Use feet below 10,000 (e.g. "5,000").
- Standard format: "[Callsign], cleared to [destination] via [SID/route], maintain [initial alt], expect [cruise alt] ten minutes after departure, departure frequency [freq], squawk [code]."
- Pilot reads back: ALL items — destination, route, initial altitude, expect altitude, frequency, squawk, callsign.`,

  pushback: `
GROUND PHASE RULES (pushback and engine start):
- NEVER mention altitude — aircraft is on the ground.
- Ground control issues pushback clearance with direction and face-to heading.
- Format: "[Callsign], push back approved, [direction], face [heading/direction]."
- May include: "start [engines] at your discretion."
- Pilot reads back: pushback direction, face heading, callsign.`,

  taxi_out: `
GROUND PHASE RULES (taxiing to runway):
- NEVER say "say altitude" — aircraft is on the ground. Say "say position" or "say your location" instead.
- NEVER ask for altitude — ask for TAXIWAY POSITION (e.g., "say position on Alpha").
- ATC issues taxi to runway via specific taxiways. Example: "[Callsign], taxi to runway 36R via Alpha, Bravo, hold short of runway 18L."
- For lost aircraft: ATC asks "Say your position" or "Confirm your location", then issues corrected taxi instructions.
- Pilot reads back: runway, taxi route (taxiway letters), hold short points, callsign.`,

  taxi_in: `
GROUND PHASE RULES (taxiing to gate after landing):
- NEVER mention altitude.
- Ground control issues taxi to gate via taxiways.
- Format: "[Callsign], taxi to gate [X] via [taxiways], hold short of [crossing runway if any]."
- Pilot reads back: gate number, taxi route, any hold-short instructions, callsign.`,

  departure: `
DEPARTURE PHASE RULES (takeoff and initial climb):
- ALTITUDE RULES: Use "FL100" for 10,000ft and above. Use feet below 10,000.
- Tower issues takeoff clearance with wind and any initial heading/SID.
- Format: "[Callsign], wind [dir] at [kts], runway [XX], cleared for takeoff." or with heading: "fly runway heading."
- After airborne, may instruct: "contact Departure on [freq]."
- Pilot reads back: runway, "cleared for takeoff" or heading if given, callsign. On frequency change: repeat frequency, callsign.`,

  climb: `
CLIMB PHASE RULES (climbing out with Departure Control):
- ALTITUDE RULES: ALWAYS use Flight Level format "FLXXX" for 10,000ft and above (e.g. "climb and maintain FL120").
- Departure issues climb clearances, headings, and frequency changes.
- Altitude format: "climb and maintain [altitude]" or "climb and maintain flight level [XXX]."
- Heading format: "fly heading [XXX]" — always three digits.
- Frequency change: "contact [facility] on [freq.decimal]."
- Pilot reads back: altitude/FL, heading (if given), frequency (if given), callsign.`,

  cruise: `
EN-ROUTE / CRUISE PHASE RULES:
- ALTITUDE RULES: ALWAYS use Flight Level format "FLXXX" (e.g. "FL350").
- Center issues altitude amendments, routing changes, frequency changes.
- Use Flight Level format: "maintain flight level [XXX]."
- Below 10,000ft use feet: "maintain [altitude]."
- Pilot reads back: altitude or FL, new routing if given, callsign.`,

  descend: `
DESCENT / APPROACH PHASE RULES:
- ALTITUDE RULES: Use "FL100" and above for Flight Levels. Feet below 10,000.
- Approach control issues descent clearance, speed control, vectors.
- Format: "descend and maintain [altitude]", "reduce speed to [kts]", "fly heading [XXX], vectors ILS runway [XX]."
- Altimeter setting must be given: "altimeter [QNH]."
- Pilot reads back: altitude, speed if given, heading, ILS runway, altimeter setting, callsign.`,

  arrival: `
ARRIVAL / ILS PHASE RULES:
- ALTITUDE RULES: Feet for altitudes below 10,000. FL for 10,000+.
- Approach issues ILS clearance with localiser intercept heading and cleared altitude.
- Format: "[Callsign], turn [heading], maintain [altitude] until established, cleared ILS runway [XX] approach."
- Pilot reads back: heading, altitude until established, "cleared ILS runway [XX]", callsign.`,


  hold: `
HOLDING PATTERN RULES:
- ATC issues holding clearance with fix, direction, inbound course, leg time/distance, expect further clearance time (EFC).
- ICAO standard format: "[Callsign], hold [direction] of [fix] on the [bearing] degree radial, [left/right] turns, [X]-minute legs, expect further clearance at [time]."
- Pilot reads back: fix, direction of hold, radial, turn direction, leg time, EFC time, callsign.`,

  emergency_weather: `
WEATHER DEVIATION EMERGENCY RULES:
- Pilot declares deviation (not necessarily MAYDAY unless structural).
- Pilot format: "[Callsign], request deviation [left/right] of course [XX] miles due to weather."
- ATC responds: "[Callsign], deviation approved, report clear of weather" or with re-routing.
- Do NOT issue altitude unless needed for terrain separation.`,

  emergency_medical: `
MEDICAL EMERGENCY RULES:
- Pilot declares MAYDAY: "MAYDAY MAYDAY MAYDAY, [callsign], medical emergency, [POB if known], request immediate landing."
- ATC responds: "[Callsign], roger MAYDAY, cleared to [airport/runway], descend and maintain [alt], [emergency services notified]."
- ATC should ask: "Number of persons on board?" and "Fuel state?"`,

  emergency_traffic: `
TCAS / TRAFFIC ALERT RULES:
- TCAS RA (Resolution Advisory) takes priority over ATC instructions.
- If TCAS RA active, pilot says: "[Callsign], TCAS RA, [climbing/descending]."
- ATC acknowledges: "[Callsign], roger, TCAS RA." ATC does NOT issue conflicting instructions during RA.
- After RA resolved: "[Callsign], TCAS RA resolved, returning to [cleared altitude]."`,
};

export function buildSessionContext(situation: Situation | string, callsign: string, customTopic = ''): string {
  const cfg = SITUATIONS[situation];
  const ctx = cfg ? cfg.context : customTopic;
  const phaseRules = PHASE_RULES[situation] ?? '';

  return `
Airport: Austin-Bergstrom International Airport (KAUS / AUS)
Active Runway: 18L/36R
ATIS: Information NOVEMBER. Wind 180 at 8 knots. Visibility 10 miles. Few clouds at 4,000. Temperature 22, Dew point 15. Altimeter 29.92. ILS approach runway 18L in use. Departure runway 36R.
Aircraft Callsign: ${callsign}
Aircraft Type: Boeing 737-800
Situation: ${ctx}
Current Phase: ${cfg ? cfg.label : customTopic}
${phaseRules}
`.trim();
}




const VALIDATION_SYSTEM_PROMPT = `You are a senior ICAO-certified ATC instructor evaluating a pilot's radio readback against a clearance.

Return ONLY valid JSON with this exact structure:
{
  "isCorrect": boolean,
  "errors": [],
  "correctReadback": "the complete correct readback in ICAO standard format",
  "score": <0-100 integer>,
  "feedback": ""
}

=== CORE PHILOSOPHY: BE GENEROUS — PENALISE ONLY REAL SAFETY-CRITICAL OMISSIONS ===

--- MANDATORY READBACK ITEMS (check ALL that appear in the clearance) ---
The pilot MUST read back:
- All ALTITUDES / FLIGHT LEVELS (e.g. "climb and maintain 8,000", "FL250")
- All HEADINGS (e.g. "fly heading 270")
- All RUNWAYS (e.g. "cleared to land runway 18L")
- All SQUAWK CODES (e.g. "squawk 4521")
- All FREQUENCY CHANGES (e.g. "contact Departure 124.0")
- The CALLSIGN (own aircraft identifier)
- Clearance limit / routing if given
For each such item in the ATC clearance, verify it appears in the readback. If any mandatory item is MISSING, add it to errors.

--- CALLSIGN RECOGNITION — ABSOLUTE BAN ON CALLSIGN ERRORS ---
NEVER add a callsign error. The only reason to ever flag callsign is if a completely different aircraft responded.
All of these formats are IDENTICAL and 100% correct:
  - Full phonetic: "November 1234 Alpha" = "N1234A" ✓
  - Spoken digits:  "November twelve thirty four alpha" = "N1234A" ✓
  - Mixed:          "N1234 Alpha" = "N1234A" ✓
  - Shortened:      "34 Alpha" or "1234A" (abbreviated callsign, standard practice) ✓
  - Airline codes:  "AI171" = "Air India 171" = "Air India one seven one" ✓
  - Callsign at START or END of transmission — both are correct.
If the callsign sounds like it matches the aircraft's callsign in ANY way, do NOT flag it.

--- PLACE NAME PHONETIC FLEXIBILITY ---
Nameplaces heard over radio are frequently corrupted. Accept ANY phonetically similar pronunciation:
  - "Hetto" or "Hutto" or "Hooto" all mean Hutto, TX. DO NOT flag.
  - "Buda" / "Byooda" — same place. DO NOT flag.
  - "Bergstrom" / "Bergstrum" — same. DO NOT flag.
General rule: if the spoken version sounds like the correct place name, accept it as correct.

--- NUMBER / LEVEL FLEXIBILITY ---
- ALTITUDE RULE: Always use Flight Level format "FLXXX" for 10,000ft and above (e.g. "FL100", "FL180", "FL250"). Use feet only for altitudes strictly below 10,000 (e.g. "8,000").
- "Flight Level 250" = "FL250" = "Two Five Zero" = "250" — all identical in the pilot's readback.
- "Eight thousand" = "8,000 feet" = "8000".
- Digits grouped differently are fine: "one two three" = "123".

--- DO NOT PENALISE ---
- Extra confirmatory phrases ("Wilco", "Roger", "Affirmative").
- Pilot asking a question AFTER the readback (e.g. "...N1234A, any PIREPs?").
- Emergency reports, PIREP information, or company position reports.
- Different but acceptable word order.
- Airline code vs. full name ("AAL" = "American").

--- SCORING ---
Start at 100. Deduct points ONLY for missing mandatory readback items:
- Missing callsign: −20
- Each missing altitude/FL: −20
- Each missing heading: −15
- Each missing runway: −15
- Each missing squawk: −20
- Each missing frequency: −15
Minimum score: 0. Never penalise for style.

--- OUTPUT RULES ---
- If isCorrect is true OR score >= 90: set errors = [] and feedback = ""
- Only populate errors[] and feedback when there are REAL factual omissions/errors.
- correctReadback: provide the shortest standard ICAO exemplar readback.
- feedback: one sentence max, only if score < 90, describing the specific omission.`;

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
      model: 'llama-3.3-70b-versatile',
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

const CHAIN_SYSTEM_PROMPT = `You are the ATC controller. 

STRICT CONCISENESS & ICAO RULES:
- BE EXTREMELY CONCISE. Eliminate all conversational filler (e.g., avoid "I show you at...", "I see you...", "Roger that").
- No greeting/closing unless essential.
- FORMAT: "[Instruction], [Callsign]" or "[Callsign], [Instruction]".
- EXAMPLE: Instead of "Air India 171, descend and maintain...", say "AI171, descend and maintain FL250."
- NEGATIONS: If something is unavailable, say "FL250 unavailable, maintain FL280, AI171."
- ALTITUDE RULE: Always use Flight Level format "FLXXX" for 10,000ft and above (e.g., "FL100", "FL180", "FL350"). Use feet only for altitudes strictly below 10,000 (e.g., "5,000").
- NO LAZY RESPONSES: If the pilot's readback is correct, do NOT just say "Roger" or "Acknowledge". Instead, PROGRESS the flight. Give them the next instruction (e.g. handoff to next frequency, next taxi waypoint, continue descent, etc.).
- REALISM: Act like a professional controller. If they are landing, give them the runway exit or ground frequency. If they are climbing, give them the next altitude or a heading.

Output ONLY valid JSON:
{
  "flight_phase": "taxi|departure|climb|cruise|descend|approach|arrival|taxi_in|parked_gate",
  "atc_transmission": "Concise radio call (e.g. 'N1234A, taxi to runway 36R')",
  "expected_readback": "The exact readback expected",
  "key_readback_items": ["item1"],
  "coaching_notes": "One brief tip",
  "session_complete": false 
}`;

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
        model: 'llama-3.3-70b-versatile',
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
        model: 'llama-3.3-70b-versatile',
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

    // Sanitise: strip phantom errors with empty given/expected/item (model hallucinations)
    const rawErrors: ReadbackError[] = parsed.errors || [];
    const cleanErrors = rawErrors.filter(
      (e) => e && (e.given?.trim() || e.expected?.trim() || e.item?.trim())
    );

    const score = Math.min(100, Math.max(0, Number(parsed.score) || 0));
    const isCorrect = cleanErrors.length === 0 && score >= 80;

    return {
      isCorrect,
      errors: cleanErrors,
      correctReadback: parsed.correctReadback || expectedReadback,
      score: isCorrect ? Math.max(score, 100) : score,
      feedback: isCorrect ? '' : (parsed.feedback || ''),
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

// ─── Airport Variety ──────────────────────────────────────────────────────────

export const AIRPORTS = [
  { 
    icao: 'KAUS', name: 'Austin–Bergstrom', location: 'Austin, TX', 
    runways: '18L/36R active', frequencies: { atis: '124.4', gnd: '121.9', twr: '119.0', app: '119.4' },
    weather: { wind: '180° @ 8kts', vis: '10SM · Few @ 4,000', alt: '29.92', temp: '22°C' }
  },
  { 
    icao: 'WSSS', name: 'Singapore Changi', location: 'Singapore', 
    runways: '02L/20R active', frequencies: { atis: '128.6', gnd: '121.7', twr: '118.6', app: '119.3' },
    weather: { wind: '010° @ 12kts', vis: '8000m · SCT @ 1,800', alt: '1008 hPa', temp: '31°C' }
  },
  { 
    icao: 'EGLL', name: 'London Heathrow', location: 'London, UK', 
    runways: '27R/09L active', frequencies: { atis: '128.07', gnd: '121.9', twr: '118.5', app: '120.4' },
    weather: { wind: '260° @ 15G25kts', vis: '6000m · BKN @ 2,500', alt: '1013 hPa', temp: '14°C' }
  },
  { 
    icao: 'KLAX', name: 'Los Angeles Intl', location: 'Los Angeles, CA', 
    runways: '24L/R, 25L/R active', frequencies: { atis: '133.8', gnd: '121.65', twr: '119.8', app: '124.3' },
    weather: { wind: '250° @ 10kts', vis: '10SM · SKC', alt: '29.95', temp: '19°C' }
  },
  { 
    icao: 'OMDB', name: 'Dubai International', location: 'Dubai, UAE', 
    runways: '12L/30R active', frequencies: { atis: '131.7', gnd: '118.35', twr: '118.75', app: '124.9' },
    weather: { wind: '330° @ 14kts', vis: '9000m · NSC', alt: '1006 hPa', temp: '38°C' }
  },
  { 
    icao: 'RJTT', name: 'Tokyo Haneda', location: 'Tokyo, Japan', 
    runways: '34L/R active', frequencies: { atis: '128.8', gnd: '118.22', twr: '118.1', app: '119.1' },
    weather: { wind: '160° @ 9kts', vis: '10km+ · SCT @ 3,000', alt: '1015 hPa', temp: '25°C' }
  },
  { 
    icao: 'YSSY', name: 'Sydney Kingsford Smith', location: 'Sydney, Australia', 
    runways: '16L/34R active', frequencies: { atis: '126.25', gnd: '121.7', twr: '120.5', app: '124.4' },
    weather: { wind: '190° @ 18kts', vis: '10km+ · BKN @ 4,500', alt: '1011 hPa', temp: '18°C' }
  },
  { 
    icao: 'EHAM', name: 'Amsterdam Schiphol', location: 'Amsterdam, Netherlands', 
    runways: '18L/36C active', frequencies: { atis: '132.97', gnd: '121.7', twr: '119.22', app: '118.4' },
    weather: { wind: '210° @ 10kts', vis: '5000m · BR · OVC @ 800', alt: '1010 hPa', temp: '11°C' }
  }
];

export function getRandomAirport() {
  const idx = Math.floor(Math.random() * AIRPORTS.length);
  return AIRPORTS[idx];
}
