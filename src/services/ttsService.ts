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

function loadVoice() {
  const voices = speechSynthesis.getVoices();
  // Prefer US English male voice for ATC feel
  const preferred = voices.find(v => v.lang === 'en-US' && /male|guy|man|david|mark|james/i.test(v.name))
    || voices.find(v => v.lang === 'en-US')
    || voices.find(v => v.lang.startsWith('en'))
    || voices[0];
  selectedVoice = preferred || null;
}

export function initTTS() {
  if (typeof speechSynthesis !== 'undefined') {
    loadVoice();
    speechSynthesis.onvoiceschanged = loadVoice;
  }
}

export function speakATC(text: string, onEnd?: () => void): void {
  if (typeof speechSynthesis === 'undefined') return;
  speechSynthesis.cancel();

  const expanded = expandAviationText(text);
  const utt = new SpeechSynthesisUtterance(expanded);

  if (selectedVoice) utt.voice = selectedVoice;
  utt.lang = 'en-US';
  utt.rate = 0.92;   // Slightly slower for clarity
  utt.pitch = 0.85;  // Slightly lower for authoritative ATC tone
  utt.volume = 1.0;

  if (onEnd) utt.onend = onEnd;
  speechSynthesis.speak(utt);
}

export function cancelTTS() {
  if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
}
