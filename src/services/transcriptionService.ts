// Transcription Service
// Uses Groq Whisper API to transcribe aviation audio

const GROQ_API_KEY = import.meta.env.VITE_GROQ_API_KEY;
const GROQ_WHISPER_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';

// Aviation-specific initial prompt to boost accuracy
const AVIATION_PROMPT = `Aviation radio communication between ATC tower/approach/departure and pilots. 
Common callsigns: N-numbers (N1234X), airline flights (AAL123, DAL456, UAL789, SWA234, FDX901).
Austin-Bergstrom International KAUS. 
Common phrases: cleared for takeoff, runway two eight left, contact departure, squawk 4521, 
altimeter 29.92, wind 280 at 12, traffic 12 o'clock, descend and maintain flight level two four zero,
turn left heading 270, frequency change approved, wilco, roger, say again, negative, affirm, 
unable, standby, go around, hold short, taxi to, line up and wait, cleared to land, 
maintain visual separation, radar contact, ident, souls on board, fuel remaining.
ATIS information, ILS approach, VOR, DME, NDB, transponder, squawk. 
Numbers read individually: 2-8-0, 2-9-9-2. Flight levels: FL240, FL350.`;

export interface TranscriptionResult {
  text: string;
  confidence: number;
  duration?: number;
  words?: Array<{ word: string; start: number; end: number; probability: number }>;
}

export async function transcribeAudio(audioBlob: Blob): Promise<TranscriptionResult> {
  const formData = new FormData();
  formData.append('file', audioBlob, 'audio.wav');
  formData.append('model', 'whisper-large-v3');
  formData.append('language', 'en');
  formData.append('response_format', 'verbose_json');
  formData.append('prompt', AVIATION_PROMPT);
  formData.append('temperature', '0');

  try {
    const response = await fetch(GROQ_WHISPER_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
      body: formData,
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Groq Whisper error ${response.status}: ${err}`);
    }

    const data = await response.json();

    // Calculate average word confidence if available
    let confidence = 0.85; // default
    if (data.segments && data.segments.length > 0) {
      const avgLogProb = data.segments.reduce((sum: number, s: any) => sum + (s.avg_logprob || -0.5), 0) / data.segments.length;
      // Convert log probability to 0-1 range (approximately)
      confidence = Math.max(0, Math.min(1, Math.exp(avgLogProb) * 1.5));
    }

    return {
      text: data.text || '',
      confidence,
      duration: data.duration,
      words: data.words,
    };
  } catch (error) {
    console.error('Transcription error:', error);
    throw error;
  }
}

/**
 * Transcribe with Groq chat model as fallback confirmation
 */
export async function refineTranscriptionWithGroq(rawText: string): Promise<string> {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'meta-llama/llama-4-scout-17b-16e-instruct',
      messages: [
        {
          role: 'system',
          content: `You are an aviation radio communication expert. 
Fix ONLY transcription errors in the following ATC radio communication text. 
Do NOT change the meaning, do NOT correct readbacks (even if wrong), do NOT add extra words.
Apply correct ICAO aviation nomenclature: callsigns, headings, altitudes, frequencies.
Return ONLY the corrected text, nothing else.`,
        },
        { role: 'user', content: rawText },
      ],
      temperature: 0.1,
      max_tokens: 300,
    }),
  });

  if (!response.ok) return rawText;
  const data = await response.json();
  return data.choices?.[0]?.message?.content?.trim() || rawText;
}
