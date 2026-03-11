// Text-to-Speech Service for ATC voice
// Uses Web Speech API SpeechSynthesis with aviation phonetics expansion

// Expand common aviation abbreviations to spoken form
function expandAviationText(text: string): string {
  return text
    // Flight levels
    .replace(/\bFL(\d{2,3})\b/gi, (_, n) => `flight level ${n.split('').join(' ')}`)
    // Frequencies like 119.0 → "one one niner point zero"
    .replace(/\b(\d{3})\.(\d{1,2})\b/g, (_, a, b) =>
      a.split('').map(toNato).join(' ') + ' point ' + b.split('').map(toNato).join(' '))
    // Altitudes 5000 through 99000
    // Prevent "I" (as in "I have") from becoming "India"
    .replace(/\bI\b/g, 'I')
    // NATO phonetics for standalone letters (except I)
    .replace(/\b([A-H|J-Z])\b/g, (_, l) => toNato(l))
    // Expand specific altitudes like 5000 -> "five thousand"
    .replace(/\b(\d000)\b/g, (match) => numberToWords(parseInt(match, 10)))
    // Everything else numeric -> split digits (e.g. 1234 -> "one two three four")
    .replace(/\d/g, (d) => toNato(d) + ' ');
}

function toNato(c: string): string {
  const map: Record<string, string> = {
    '0': 'zero', '1': 'one', '2': 'two', '3': 'three', '4': 'four',
    '5': 'five', '6': 'six', '7': 'seven', '8': 'eight', '9': 'niner',
    'A': 'alpha', 'B': 'bravo', 'C': 'charlie', 'D': 'delta', 'E': 'echo',
    'F': 'foxtrot', 'G': 'golf', 'H': 'hotel', 'I': 'india', 'J': 'juliet',
    'K': 'kilo', 'L': 'lima', 'M': 'mike', 'N': 'november', 'O': 'oscar',
    'P': 'papa', 'Q': 'quebec', 'R': 'romeo', 'S': 'sierra', 'T': 'tango',
    'U': 'uniform', 'V': 'victor', 'W': 'whiskey', 'X': 'x-ray', 'Y': 'yankee',
    'Z': 'zulu',
  };
  return map[c.toUpperCase()] || c;
}

function numberToWords(n: number): string {
  if (n === 0) return 'zero';
  const ones = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
    'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
  const tens = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
  if (n >= 1000) {
    const thou = Math.floor(n / 1000);
    const rem = n % 1000;
    return (thou < 20 ? ones[thou] : tens[Math.floor(thou / 10)] + (thou % 10 ? ' ' + ones[thou % 10] : ''))
      + ' thousand' + (rem ? ' ' + numberToWords(rem) : '');
  }
  if (n >= 100) return ones[Math.floor(n / 100)] + ' hundred' + (n % 100 ? ' ' + numberToWords(n % 100) : '');
  if (n >= 20) return tens[Math.floor(n / 10)] + (n % 10 ? ' ' + ones[n % 10] : '');
  return ones[n];
}

let selectedVoice: SpeechSynthesisVoice | null = null;
let audioCtx: AudioContext | null = null;
let staticNode: AudioBufferSourceNode | null = null;
let gainNode: GainNode | null = null;

export function getRandomVoice(): string {
  if (typeof speechSynthesis === 'undefined') return '';
  const voices = speechSynthesis.getVoices();
  const englishVoices = voices.filter(v => v.lang.startsWith('en'));
  const random = englishVoices[Math.floor(Math.random() * englishVoices.length)];
  return random?.name || '';
}

function loadVoice(voiceName?: string) {
  const voices = speechSynthesis.getVoices();
  if (voiceName) {
    selectedVoice = voices.find(v => v.name === voiceName) || null;
  }
  
  if (!selectedVoice) {
    const englishVoices = voices.filter(v => v.lang.startsWith('en'));
    const random = englishVoices[Math.floor(Math.random() * englishVoices.length)];
    selectedVoice = random || voices[0] || null;
  }
}

export function initTTS() {
  if (typeof speechSynthesis !== 'undefined') {
    speechSynthesis.onvoiceschanged = () => {
      // Don't auto-reset if someone is talking
    };
  }
}

// Generates a "Radio Static" effect using White Noise + Bandpass Filter
function startRadioStatic(intensity = 0.05) {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();

    // 1. Create White Noise with a bit of "crackle" (random pulses)
    const bufferSize = audioCtx.sampleRate * 2;
    const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
    const output = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
        const white = Math.random() * 2 - 1;
        // Occasional extra "crackle" spike
        const crackle = Math.random() > 0.999 ? (Math.random() * 4 - 2) : 0;
        output[i] = white + crackle;
    }

    staticNode = audioCtx.createBufferSource();
    staticNode.buffer = buffer;
    staticNode.loop = true;

    // 2. Filter it to sound like a radio (narrow band)
    const filter = audioCtx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 1500;
    filter.Q.value = 1.0;

    gainNode = audioCtx.createGain();
    gainNode.gain.value = intensity;

    staticNode.connect(filter);
    filter.connect(gainNode);
    gainNode.connect(audioCtx.destination);

    staticNode.start();
  } catch (e) {
    console.error("Audio FX error:", e);
  }
}

function stopRadioStatic() {
  if (staticNode) {
    try {
      staticNode.stop();
      staticNode.disconnect();
    } catch(e) {}
    staticNode = null;
  }
}

export function speakATC(text: string, onEnd?: () => void, difficulty: 'easy' | 'normal' | 'hard' = 'normal', voiceName?: string): void {
  if (typeof speechSynthesis === 'undefined') return;
  speechSynthesis.cancel();
  stopRadioStatic();

  // Use specific voice if provided, or pick one
  loadVoice(voiceName);

  const expanded = expandAviationText(text);
  const utt = new SpeechSynthesisUtterance(expanded);

  // Difficulty influences radio quality (sharply increased for realism)
  const staticIntensity = difficulty === 'hard' ? 0.18 : difficulty === 'normal' ? 0.08 : 0.04;
  const speechRate = difficulty === 'hard' ? 1.30 : difficulty === 'normal' ? 1.10 : 0.95;

  if (selectedVoice) utt.voice = selectedVoice;
  utt.rate = speechRate;
  utt.pitch = 0.85; // Slightly lower pitch for more "radio" feel
  utt.volume = 1.0;

  utt.onstart = () => startRadioStatic(staticIntensity);
  
  utt.onend = () => {
    stopRadioStatic();
    if (onEnd) onEnd();
  };

  utt.onerror = () => stopRadioStatic();

  speechSynthesis.speak(utt);
}

export function cancelTTS() {
  if (typeof speechSynthesis !== 'undefined') {
    speechSynthesis.cancel();
    stopRadioStatic();
  }
}
