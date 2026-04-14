import { useEffect, useRef, useState } from 'react';
import { Odyssey } from '@odysseyml/odyssey';
import './App.css';

const STYLE_OPTIONS = [
  { id: 'realism', label: 'Realism' },
  { id: 'comic', label: 'Comic' },
  { id: 'manga', label: 'Manga' },
  { id: 'ghibli-inspired', label: 'Ghibli-inspired' },
] as const;

type OdysseyStatus = 'idle' | 'connecting' | 'connected' | 'streaming' | 'error';

type GeneratedImage = {
  blob: Blob;
  mimeType: string;
  previewUrl: string;
};

const MAX_STREAM_DURATION_MS = 30_000;

function getApiUrl(path: string) {
  if (!import.meta.env.DEV) return path;
  return `${window.location.protocol}//${window.location.hostname}:8787${path}`;
}

async function readJsonResponse<T>(res: Response): Promise<T> {
  const raw = await res.text();
  if (!raw) return {} as T;

  try {
    return JSON.parse(raw) as T;
  } catch {
    const snippet = raw.replace(/\s+/g, ' ').slice(0, 140);
    throw new Error(`Expected JSON from ${res.url}, but received: ${snippet}`);
  }
}

function getGenerateErrorMessage(data: { error?: string; reason?: string } | null | undefined) {
  if (data?.reason === 'safety') {
    return 'Image rejected: this upload was flagged as NSFW or unsafe. Try a different image.';
  }
  return data?.error || 'Image generation failed.';
}

function getAnimationErrorMessage(err: unknown) {
  const message = err instanceof Error ? err.message : 'Animation failed.';
  const text = message.toLowerCase();

  if (
    text.includes('nsfw') ||
    text.includes('safety') ||
    text.includes('unsafe') ||
    text.includes('explicit') ||
    text.includes('policy') ||
    text.includes('blocked')
  ) {
    return 'Animation blocked: this image was flagged as NSFW or unsafe.';
  }

  return message;
}

function App() {
  const [selectedStyle, setSelectedStyle] = useState<(typeof STYLE_OPTIONS)[number]['id']>('realism');
  const [drawingFile, setDrawingFile] = useState<File | null>(null);
  const [generateStatus, setGenerateStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [generatedImage, setGeneratedImage] = useState<GeneratedImage | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [streamPrompt, setStreamPrompt] = useState('animate it');
  const [streamPromptInput, setStreamPromptInput] = useState('');
  const [streamPromptStatus, setStreamPromptStatus] = useState<'idle' | 'sending' | 'error'>('idle');
  const [streamPromptError, setStreamPromptError] = useState<string | null>(null);
  const [animationError, setAnimationError] = useState<string | null>(null);

  const [odysseyStatus, setOdysseyStatus] = useState<OdysseyStatus>('idle');
  const [odysseyApiKey, setOdysseyApiKey] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const cameraVideoRef = useRef<HTMLVideoElement | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const odysseyClientRef = useRef<Odyssey | null>(null);
  const connectingRef = useRef(false);
  const streamTimeoutRef = useRef<number | null>(null);

  const canGenerate = Boolean(drawingFile) && generateStatus !== 'loading';
  const canAnimate = Boolean(generatedImage) && odysseyStatus !== 'connecting' && odysseyStatus !== 'streaming';
  const canSendPrompt = odysseyStatus === 'streaming' && streamPromptInput.trim().length > 0 && streamPromptStatus !== 'sending';

  useEffect(() => {
    let isMounted = true;
    fetch(getApiUrl('/api/odyssey/token'))
      .then((res) => (res.ok ? readJsonResponse<{ apiKey?: string }>(res) : null))
      .then((data) => {
        if (!isMounted) return;
        if (data?.apiKey) setOdysseyApiKey(data.apiKey);
      })
      .catch(() => {});
    return () => {
      isMounted = false;
      try {
        odysseyClientRef.current?.disconnect();
      } catch {
        // noop
      }
    };
  }, []);

  useEffect(() => {
    return () => {
      if (generatedImage?.previewUrl) {
        URL.revokeObjectURL(generatedImage.previewUrl);
      }
    };
  }, [generatedImage]);

  useEffect(() => {
    return () => {
      clearStreamTimeout();
    };
  }, []);

  useEffect(() => {
    if (!cameraOpen) {
      stopCameraStream();
      return;
    }

    let active = true;

    async function startCamera() {
      setCameraError(null);

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        });

        if (!active) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        cameraStreamRef.current = stream;
        if (cameraVideoRef.current) {
          cameraVideoRef.current.srcObject = stream;
        }
      } catch {
        setCameraError('Camera access failed.');
      }
    }

    void startCamera();

    return () => {
      active = false;
      stopCameraStream();
    };
  }, [cameraOpen]);

  function stopCameraStream() {
    if (cameraVideoRef.current) {
      cameraVideoRef.current.srcObject = null;
    }
    if (cameraStreamRef.current) {
      cameraStreamRef.current.getTracks().forEach((track) => track.stop());
      cameraStreamRef.current = null;
    }
  }

  function clearStreamTimeout() {
    if (streamTimeoutRef.current !== null) {
      window.clearTimeout(streamTimeoutRef.current);
      streamTimeoutRef.current = null;
    }
  }

  function startStreamTimeout() {
    clearStreamTimeout();
    streamTimeoutRef.current = window.setTimeout(() => {
      void handleEndStream(true);
    }, MAX_STREAM_DURATION_MS);
  }

  async function generateFromFile(file: File) {
    setGenerateStatus('loading');
    setGenerateError(null);
    setAnimationError(null);

    const formData = new FormData();
    formData.append('image', file);
    formData.append('style', selectedStyle);

    try {
      const res = await fetch(getApiUrl('/api/nano-banana'), {
        method: 'POST',
        body: formData,
      });
      const data = await readJsonResponse<{ error?: string; reason?: string; mimeType?: string; imageBase64?: string }>(res);
      if (!res.ok) {
        throw new Error(getGenerateErrorMessage(data));
      }
      const mimeType = data?.mimeType || 'image/png';
      const base64 = data?.imageBase64 || '';
      if (!base64) throw new Error('No image returned.');
      const blob = base64ToBlob(base64, mimeType);
      const previewUrl = URL.createObjectURL(blob);
      setGeneratedImage({ blob, mimeType, previewUrl });
      setGenerateStatus('done');
      setStreamPrompt('animate it');
    } catch (err) {
      setGenerateStatus('error');
      setGenerateError(err instanceof Error ? err.message : 'Image generation failed.');
    }
  }

  async function handleGenerate() {
    if (!drawingFile) return;
    await generateFromFile(drawingFile);
  }

  function base64ToBlob(base64: string, mimeType: string) {
    const buffer = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    return new Blob([buffer], { type: mimeType });
  }

  async function connectOdyssey() {
    if (connectingRef.current) return;
    if (!odysseyApiKey) {
      setOdysseyStatus('error');
      setAnimationError('Odyssey is not configured.');
      return;
    }
    if (odysseyClientRef.current && odysseyStatus === 'connected') return;

    connectingRef.current = true;
    setOdysseyStatus('connecting');

    try {
      if (!odysseyClientRef.current) {
        odysseyClientRef.current = new Odyssey({ apiKey: odysseyApiKey });
      }
      const mediaStream = await odysseyClientRef.current.connect();
      if (videoRef.current) {
        videoRef.current.srcObject = mediaStream;
      }
      setOdysseyStatus('connected');
    } catch (err) {
      setOdysseyStatus('error');
      setAnimationError(getAnimationErrorMessage(err));
    } finally {
      connectingRef.current = false;
    }
  }

  async function handleStartAnimation() {
    if (!generatedImage) return;
    setAnimationError(null);
    if (odysseyStatus !== 'connected') {
      await connectOdyssey();
    }
    if (!odysseyClientRef.current) return;

    try {
      const file = new File([generatedImage.blob], 'nano-banana.png', { type: generatedImage.mimeType });
      setOdysseyStatus('connecting');
      await odysseyClientRef.current.startStream({
        prompt: streamPrompt,
        image: file,
        portrait: false,
      });
      setOdysseyStatus('streaming');
      startStreamTimeout();
    } catch (err) {
      setOdysseyStatus('error');
      setAnimationError(getAnimationErrorMessage(err));
    }
  }

  async function handleSendPrompt() {
    const prompt = streamPromptInput.trim();
    if (!prompt || !odysseyClientRef.current || odysseyStatus !== 'streaming') return;

    try {
      setStreamPromptStatus('sending');
      setStreamPromptError(null);
      await odysseyClientRef.current.interact({ prompt });
      setStreamPrompt(prompt);
      setStreamPromptInput('');
      setStreamPromptStatus('idle');
    } catch (err) {
      setStreamPromptStatus('error');
      setStreamPromptError(err instanceof Error ? err.message : 'Failed to send prompt.');
    }
  }

  async function handleEndStream(fromTimeout = false) {
    if (!odysseyClientRef.current) return;
    try {
      clearStreamTimeout();
      await odysseyClientRef.current.endStream();
      setOdysseyStatus('connected');
      setAnimationError(fromTimeout ? 'Animation ended after 30 seconds.' : null);
    } catch (err) {
      setOdysseyStatus('error');
      setAnimationError(getAnimationErrorMessage(err));
    }
  }

  async function handleFullscreen() {
    const video = videoRef.current;
    if (!video) return;
    const anyVideo = video as HTMLVideoElement & {
      webkitRequestFullscreen?: () => Promise<void> | void;
      msRequestFullscreen?: () => Promise<void> | void;
    };
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else if (anyVideo.requestFullscreen) {
        await anyVideo.requestFullscreen();
      } else if (anyVideo.webkitRequestFullscreen) {
        anyVideo.webkitRequestFullscreen();
      } else if (anyVideo.msRequestFullscreen) {
        anyVideo.msRequestFullscreen();
      }
    } catch {
      // Ignore fullscreen errors.
    }
  }

  function applySelectedFile(file: File | null) {
    setDrawingFile(file);
    setGenerateStatus('idle');
    setGenerateError(null);
    if (generatedImage?.previewUrl) {
      URL.revokeObjectURL(generatedImage.previewUrl);
    }
    setGeneratedImage(null);
    setStreamPrompt('animate it');
    setStreamPromptInput('');
    setStreamPromptStatus('idle');
    setStreamPromptError(null);
    setAnimationError(null);
    clearStreamTimeout();
  }

  function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] || null;
    applySelectedFile(file);
    event.target.value = '';
  }

  function handleCameraClick() {
    setCameraOpen(true);
  }

  function handleCloseCamera() {
    setCameraOpen(false);
    setCameraError(null);
  }

  async function handleCapturePhoto() {
    const video = cameraVideoRef.current;
    if (!video) return;

    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) {
      setCameraError('Camera is not ready yet.');
      return;
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) {
      setCameraError('Camera capture failed.');
      return;
    }

    context.drawImage(video, 0, 0, width, height);

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, 'image/jpeg', 0.92);
    });

    if (!blob) {
      setCameraError('Camera capture failed.');
      return;
    }

    const file = new File([blob], `camera-snap-${Date.now()}.jpg`, { type: 'image/jpeg' });
    applySelectedFile(file);
    handleCloseCamera();
    await generateFromFile(file);
  }


  return (
    <div className="page">
      <header className="hero">
        <div>
          <p className="eyebrow">Make your drawing come alive 🎬</p>
          <h1>make your doodles in real worlds</h1>
          <p className="subhead">Draw it. Upload it. Watch it move.</p>
        </div>
      </header>

      <main className="grid">
        <section className="panel">
          <h2>1. Upload Drawing</h2>
          <div className="upload-actions">
            <label className="upload">
              <input type="file" accept="image/*" onChange={handleFileChange} />
              <span>{drawingFile ? drawingFile.name : 'Choose an image file'}</span>
            </label>
            <button className="camera-button" type="button" onClick={handleCameraClick} aria-label="Take a photo">
              <span className="camera-icon" aria-hidden="true" />
            </button>
          </div>
          <div className="controls">
            <label>
              Style
              <select value={selectedStyle} onChange={(e) => setSelectedStyle(e.target.value as typeof selectedStyle)}>
                {STYLE_OPTIONS.map((style) => (
                  <option key={style.id} value={style.id}>
                    {style.label}
                  </option>
                ))}
              </select>
            </label>
            <button className="primary" onClick={handleGenerate} disabled={!canGenerate}>
              {generateStatus === 'loading' ? 'Generating…' : 'Generate Nano Banana'}
            </button>
          </div>
          {generateError && <p className="error">{generateError}</p>}
        </section>

        <section className="panel preview">
          <h2>2. Preview</h2>
          {generatedImage ? (
            <img src={generatedImage.previewUrl} alt="Generated nano banana" />
          ) : generateStatus === 'loading' ? (
            <div className="loading-card" aria-live="polite">
              <div className="spinner" />
              <p>Generating your Nano Banana image...</p>
            </div>
          ) : (
            <div className="placeholder">Generated image preview appears here.</div>
          )}
        </section>

        <section className="panel video">
          <h2>3. Animate</h2>
          <div className="video-frame">
            <video ref={videoRef} autoPlay playsInline muted />
            {odysseyStatus === 'connecting' && (
              <div className="video-overlay" aria-live="polite">
                <div className="spinner spinner-light" />
                <p>Starting Odyssey stream...</p>
              </div>
            )}
            <button className="fullscreen-btn" onClick={handleFullscreen} aria-label="Full screen" title="Full screen">
              <span />
              <span />
              <span />
              <span />
            </button>
          </div>
          <div className="controls">
            <button className="primary" onClick={handleStartAnimation} disabled={!canAnimate}>
              Start Animation
            </button>
            <button className="ghost" onClick={() => void handleEndStream()} disabled={odysseyStatus !== 'streaming'}>
              End Stream
            </button>
          </div>
          <div className="stream-prompt">
            <div className="prompt-row">
              <input
                id="stream-prompt"
                type="text"
                value={streamPromptInput}
                onChange={(e) => setStreamPromptInput(e.target.value)}
                placeholder="add what you want"
                disabled={odysseyStatus !== 'streaming'}
              />
              <button className="ghost" onClick={handleSendPrompt} disabled={!canSendPrompt}>
                {streamPromptStatus === 'sending' ? 'Sending…' : 'Send Prompt'}
              </button>
            </div>
            {streamPromptError && <p className="error">{streamPromptError}</p>}
            {animationError && <p className="error">{animationError}</p>}
          </div>
        </section>
      </main>

      {cameraOpen && (
        <div className="camera-modal" role="dialog" aria-modal="true" aria-label="Camera">
          <div className="camera-sheet">
            <div className="camera-preview">
              <video ref={cameraVideoRef} autoPlay playsInline muted />
            </div>
            {cameraError && <p className="error">{cameraError}</p>}
            <div className="camera-controls">
              <button className="ghost" type="button" onClick={handleCloseCamera}>
                Close
              </button>
              <button className="primary" type="button" onClick={handleCapturePhoto}>
                Take Photo
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

export default App;
