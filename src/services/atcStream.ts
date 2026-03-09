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

      // Create audio element pointing directly at LiveATC's Edge Node
      this.audioEl = new Audio();
      // The edge node (unlike the load balancer) sends Access-Control-Allow-Origin: *
      // This means we CAN use crossOrigin and the WebAudio API without being tainted!
      this.audioEl.crossOrigin = 'anonymous';
      this.audioEl.src = 'https://s1-bos.liveatc.net/kaus3_app_dep';
      this.audioEl.volume = 1.0;

      // Re-enable Web Audio pipeline for transcription processing
      this.audioCtx = new AudioContext({ sampleRate: 16000 });
      const sourceNode = this.audioCtx.createMediaElementSource(this.audioEl);

      // High-pass filter to remove low rumble
      const hp = this.audioCtx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 280;

      // Low-pass filter to match VHF voice band
      const lp = this.audioCtx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 3500;

      // Gain for normalization
      this.gainNode = this.audioCtx.createGain();
      this.gainNode.gain.value = 2.5;

      // Destination for MediaRecorder
      this.dest = this.audioCtx.createMediaStreamDestination();

      // Chain: source → hp → lp → gain → dest + speakers
      sourceNode.connect(hp);
      hp.connect(lp);
      lp.connect(this.gainNode);
      this.gainNode.connect(this.dest);
      this.gainNode.connect(this.audioCtx.destination); // For listening
      
      // Start recorder (it will successfully record and chunk stream audio now!)
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
