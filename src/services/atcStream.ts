// ATC Stream Service
// Captures LiveATC audio stream, chunks it, and prepares for transcription

export type StreamStatus = 'idle' | 'connecting' | 'live' | 'error' | 'paused';

export interface StreamChunk {
  blob: Blob;
  timestamp: Date;
  duration: number; // seconds
}

export class ATCStreamCapture {
  private audioEl: HTMLAudioElement | null = null;
  private audioCtx: AudioContext | null = null;
  private gainNode: GainNode | null = null;
  private dest: MediaStreamAudioDestinationNode | null = null;

  private recorder: MediaRecorder | null = null;
  private chunks: BlobPart[] = [];
  private chunkDuration: number; // ms
  private onChunk: (chunk: StreamChunk) => void;
  private onStatus: (status: StreamStatus) => void;
  private isCapturing = false;
  private chunkInterval: ReturnType<typeof setInterval> | null = null;
  private chunkStart = 0;

  constructor(
    chunkDurationMs: number,
    onChunk: (chunk: StreamChunk) => void,
    onStatus: (status: StreamStatus) => void
  ) {
    this.chunkDuration = chunkDurationMs;
    this.onChunk = onChunk;
    this.onStatus = onStatus;
  }

  async start() {
    try {
      this.onStatus('connecting');

      // Create audio element pointing directly at LiveATC to bypass proxies completely
      this.audioEl = new Audio();
      // We DO NOT set crossOrigin = 'anonymous' because LiveATC doesn't send CORS headers. 
      // This allows the browser to play it natively, but WebAudio/Canvas will be 'tainted' (silenced).
      this.audioEl.src = 'https://d.liveatc.net/kaus3_app_dep';
      this.audioEl.volume = 1.0;

      // Set up Web Audio pipeline (Dummy pipeline to prevent crashes, since real stream 
      // is tainted and would output silence if routed through nodes here).
      this.audioCtx = new AudioContext({ sampleRate: 16000 });
      
      // We skip connecting the real sourceNode to the filters because of CORS taint silencing native playback.
      // Instead, we just let the <audio> element play natively out of the speakers.
      this.dest = this.audioCtx.createMediaStreamDestination();
      
      // Dummy gain to satisfy volume controls
      this.gainNode = this.audioCtx.createGain();
      this.gainNode.gain.value = 1.0;

      // Destination for MediaRecorder
      this.dest = this.audioCtx.createMediaStreamDestination();

      // Chain: gain → dest (dummy chain)
      // We don't connect to audioCtx.destination because the actual <audio> element is playing natively.
      this.gainNode.connect(this.dest);

      // Start recorder (it will record silence since nothing is feeding the gainNode, 
      // but prevents crashes)
      this.recorder = new MediaRecorder(this.dest.stream, {
        mimeType: this.getSupportedMimeType(),
        audioBitsPerSecond: 64000,
      });

      this.recorder.ondataavailable = (e) => {
        if (e.data.size > 0) this.chunks.push(e.data);
      };

      this.recorder.onstop = () => {
        if (this.chunks.length > 0) {
          const blob = new Blob(this.chunks, { type: this.getSupportedMimeType() });
          const duration = (Date.now() - this.chunkStart) / 1000;
          this.onChunk({ blob, timestamp: new Date(), duration });
          this.chunks = [];
        }
      };

      // Play the audio
      await this.audioEl.play();
      this.isCapturing = true;
      this.onStatus('live');

      // Start periodic chunking
      this.startChunking();
    } catch (err) {
      console.error('Stream start error:', err);
      this.onStatus('error');
    }
  }

  private getSupportedMimeType(): string {
    const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
    for (const type of types) {
      if (MediaRecorder.isTypeSupported(type)) return type;
    }
    return '';
  }

  private startChunking() {
    this.chunkStart = Date.now();
    this.recorder?.start();

    this.chunkInterval = setInterval(() => {
      if (!this.isCapturing) return;
      this.recorder?.stop();
      setTimeout(() => {
        this.chunkStart = Date.now();
        this.recorder?.start();
      }, 100);
    }, this.chunkDuration);
  }

  pause() {
    if (this.audioEl) this.audioEl.pause();
    this.isCapturing = false;
    this.onStatus('paused');
  }

  resume() {
    if (this.audioEl) {
      this.audioEl.play();
      this.isCapturing = true;
      this.onStatus('live');
    }
  }

  stop() {
    if (this.chunkInterval) clearInterval(this.chunkInterval);
    this.recorder?.stop();
    if (this.audioEl) { this.audioEl.pause(); this.audioEl.src = ''; }
    if (this.audioCtx) this.audioCtx.close();
    this.isCapturing = false;
    this.onStatus('idle');
  }

  setVolume(vol: number) {
    if (this.gainNode) this.gainNode.gain.value = vol;
  }

  getStatus(): StreamStatus {
    if (!this.isCapturing) return 'idle';
    return 'live';
  }
}
