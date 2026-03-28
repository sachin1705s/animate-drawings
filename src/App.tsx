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

function App() {
  const [selectedStyle, setSelectedStyle] = useState<(typeof STYLE_OPTIONS)[number]['id']>('realism');
  const [drawingFile, setDrawingFile] = useState<File | null>(null);
  const [generateStatus, setGenerateStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [generatedImage, setGeneratedImage] = useState<GeneratedImage | null>(null);

  const [odysseyStatus, setOdysseyStatus] = useState<OdysseyStatus>('idle');
  const [odysseyApiKey, setOdysseyApiKey] = useState<string | null>(null);
  const [midPrompt, setMidPrompt] = useState<string>('');
  const [midPromptStatus, setMidPromptStatus] = useState<'idle' | 'sending' | 'error'>('idle');
  const [midPromptError, setMidPromptError] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const odysseyClientRef = useRef<Odyssey | null>(null);
  const connectingRef = useRef(false);

  const canGenerate = Boolean(drawingFile) && generateStatus !== 'loading';
  const canAnimate = Boolean(generatedImage) && odysseyStatus !== 'connecting' && odysseyStatus !== 'streaming';

  useEffect(() => {
    let isMounted = true;
    fetch('/api/odyssey/token')
      .then((res) => (res.ok ? res.json() : null))
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

  async function handleGenerate() {
    if (!drawingFile) return;
    setGenerateStatus('loading');
    setGenerateError(null);

    const formData = new FormData();
    formData.append('image', drawingFile);
    formData.append('style', selectedStyle);

    try {
      const res = await fetch('/api/nano-banana', {
        method: 'POST',
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || 'Image generation failed.');
      }
      const mimeType = data?.mimeType || 'image/png';
      const base64 = data?.imageBase64 || '';
      if (!base64) throw new Error('No image returned.');
      const buffer = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const blob = new Blob([buffer], { type: mimeType });
      const previewUrl = URL.createObjectURL(blob);
      setGeneratedImage({ blob, mimeType, previewUrl });
      setGenerateStatus('done');
    } catch (err) {
      setGenerateStatus('error');
      setGenerateError(err instanceof Error ? err.message : 'Image generation failed.');
    }
  }

  async function connectOdyssey() {
    if (connectingRef.current) return;
    if (!odysseyApiKey) {
      setOdysseyStatus('error');
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
    } finally {
      connectingRef.current = false;
    }
  }

  async function handleStartAnimation() {
    if (!generatedImage) return;
    if (odysseyStatus !== 'connected') {
      await connectOdyssey();
    }
    if (!odysseyClientRef.current) return;

    try {
      const file = new File([generatedImage.blob], 'nano-banana.png', { type: generatedImage.mimeType });
      setOdysseyStatus('streaming');
      await odysseyClientRef.current.startStream({
        prompt: 'animate it',
        image: file,
        portrait: false,
      });
    } catch (err) {
      setOdysseyStatus('error');
    }
  }

  async function handleMidPrompt() {
    if (!odysseyClientRef.current) return;
    const prompt = midPrompt.trim();
    if (!prompt) return;
    setMidPromptStatus('sending');
    setMidPromptError(null);
    try {
      await odysseyClientRef.current.interact({ prompt });
      setMidPromptStatus('idle');
    } catch (err) {
      setMidPromptStatus('error');
      setMidPromptError(err instanceof Error ? err.message : 'Failed to send prompt.');
    }
  }

  async function handleEndStream() {
    if (!odysseyClientRef.current) return;
    try {
      await odysseyClientRef.current.endStream();
      setOdysseyStatus('connected');
    } catch (err) {
      setOdysseyStatus('error');
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

  function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] || null;
    setDrawingFile(file);
    setGenerateStatus('idle');
    setGenerateError(null);
    if (generatedImage?.previewUrl) {
      URL.revokeObjectURL(generatedImage.previewUrl);
    }
    setGeneratedImage(null);
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
          <label className="upload">
            <input type="file" accept="image/*" onChange={handleFileChange} />
            <span>{drawingFile ? drawingFile.name : 'Choose an image file'}</span>
          </label>
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
          ) : (
            <div className="placeholder">Generated image preview appears here.</div>
          )}
        </section>

        <section className="panel video">
          <h2>3. Animate</h2>
          <div className="video-frame">
            <video ref={videoRef} autoPlay playsInline muted />
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
            <button className="ghost" onClick={handleEndStream} disabled={odysseyStatus !== 'streaming'}>
              End Stream
            </button>
          </div>
          <div className="mid-prompt">
            <label>
              Mid‑stream prompt
              <input
                type="text"
                placeholder="e.g., make it wave"
                value={midPrompt}
                onChange={(e) => setMidPrompt(e.target.value)}
              />
            </label>
            <button
              className="ghost"
              onClick={handleMidPrompt}
              disabled={odysseyStatus !== 'streaming' || midPromptStatus === 'sending'}
            >
              {midPromptStatus === 'sending' ? 'Sending…' : 'Send Prompt'}
            </button>
          </div>
          {midPromptError && <p className="status-error">{midPromptError}</p>}
        </section>
      </main>

      <footer className="footer">
        <p>Prompt is fixed to “animate it”. Generated images are not stored.</p>
      </footer>
    </div>
  );
}

export default App;
