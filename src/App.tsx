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

type ImageAnalysis = {
  place: string;
  story: string;
  musicPrompt: string;
};

function App() {
  const [selectedStyle, setSelectedStyle] = useState<(typeof STYLE_OPTIONS)[number]['id']>('realism');
  const [drawingFile, setDrawingFile] = useState<File | null>(null);
  const [generateStatus, setGenerateStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [generatedImage, setGeneratedImage] = useState<GeneratedImage | null>(null);
  const [generatedImageBase64, setGeneratedImageBase64] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<ImageAnalysis | null>(null);
  const [audioStatus, setAudioStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [audioError, setAudioError] = useState<string | null>(null);
  const [musicUrl, setMusicUrl] = useState<string | null>(null);
  const [narrationUrl, setNarrationUrl] = useState<string | null>(null);
  const [autoPlayRequested, setAutoPlayRequested] = useState(false);
  const [audioStarted, setAudioStarted] = useState(false);
  const [generatedBase64, setGeneratedBase64] = useState<string>('');
  const [generatedMime, setGeneratedMime] = useState<string>('image/png');
  const [analysisStatus, setAnalysisStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [storyText, setStoryText] = useState<string>('');
  const [musicPrompt, setMusicPrompt] = useState<string>('');
  const [audioStatus, setAudioStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [audioError, setAudioError] = useState<string | null>(null);
  const [musicUrl, setMusicUrl] = useState<string | null>(null);
  const [narrationUrl, setNarrationUrl] = useState<string | null>(null);
  const [pendingPlayback, setPendingPlayback] = useState(false);

  const [odysseyStatus, setOdysseyStatus] = useState<OdysseyStatus>('idle');
  const [odysseyApiKey, setOdysseyApiKey] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const odysseyClientRef = useRef<Odyssey | null>(null);
  const connectingRef = useRef(false);
  const musicAudioRef = useRef<HTMLAudioElement | null>(null);
  const narrationAudioRef = useRef<HTMLAudioElement | null>(null);
  const musicAudioRef = useRef<HTMLAudioElement | null>(null);
  const narrationAudioRef = useRef<HTMLAudioElement | null>(null);

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

  useEffect(() => {
    return () => {
      if (musicUrl) URL.revokeObjectURL(musicUrl);
      if (narrationUrl) URL.revokeObjectURL(narrationUrl);
    };
  }, [musicUrl, narrationUrl]);

  useEffect(() => {
    if (musicAudioRef.current) {
      musicAudioRef.current.load();
    }
  }, [musicUrl]);

  useEffect(() => {
    if (narrationAudioRef.current) {
      narrationAudioRef.current.load();
    }
  }, [narrationUrl]);

  useEffect(() => {
    if (!autoPlayRequested || audioStarted || !musicUrl || !narrationUrl) return;
    void startAudioPlayback();
  }, [autoPlayRequested, audioStarted, musicUrl, narrationUrl]);

  function base64ToBlob(base64: string, mimeType: string) {
    const buffer = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    return new Blob([buffer], { type: mimeType });
  }

  async function startAudioPlayback() {
    if (!musicAudioRef.current || !narrationAudioRef.current) return;
    musicAudioRef.current.volume = 0.6;
    narrationAudioRef.current.volume = 1.0;
    try {
      await Promise.allSettled([
        musicAudioRef.current.play(),
        narrationAudioRef.current.play(),
      ]);
      setAudioStarted(true);
    } catch {
      // ignore autoplay issues
    }
  }

  async function buildSoundForImage(imageBase64: string, mimeType: string) {
    setAudioStatus('loading');
    setAudioError(null);
    setAnalysis(null);
    setAutoPlayRequested(false);
    setAudioStarted(false);
    if (musicUrl) URL.revokeObjectURL(musicUrl);
    if (narrationUrl) URL.revokeObjectURL(narrationUrl);
    setMusicUrl(null);
    setNarrationUrl(null);

    try {
      const analysisRes = await fetch('/api/analyze-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageBase64, mimeType }),
      });
      const analysisData = await analysisRes.json();
      if (!analysisRes.ok) {
        throw new Error(analysisData?.error || 'Image analysis failed.');
      }
      setAnalysis(analysisData);

      const [musicRes, narrRes] = await Promise.all([
        fetch('/api/lyria', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ musicPrompt: analysisData.musicPrompt }),
        }),
        fetch('/api/narrate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ storyText: analysisData.story }),
        }),
      ]);

      const musicData = await musicRes.json();
      if (!musicRes.ok) {
        throw new Error(musicData?.error || 'Music generation failed.');
      }
      const narrData = await narrRes.json();
      if (!narrRes.ok) {
        throw new Error(narrData?.error || 'Narration failed.');
      }

      const musicBlob = base64ToBlob(musicData.audioBase64, musicData.mimeType || 'audio/mpeg');
      const narrationBlob = base64ToBlob(narrData.audioBase64, narrData.mimeType || 'audio/wav');
      setMusicUrl(URL.createObjectURL(musicBlob));
      setNarrationUrl(URL.createObjectURL(narrationBlob));
      setAudioStatus('ready');
    } catch (err) {
      setAudioStatus('error');
      setAudioError(err instanceof Error ? err.message : 'Audio generation failed.');
    }
  }

  useEffect(() => {
    return () => {
      if (musicUrl) URL.revokeObjectURL(musicUrl);
      if (narrationUrl) URL.revokeObjectURL(narrationUrl);
    };
  }, [musicUrl, narrationUrl]);

  useEffect(() => {
    if (!pendingPlayback) return;
    if (odysseyStatus !== 'streaming') return;
    if (!musicUrl || !narrationUrl) return;
    void startAudioPlayback();
    setPendingPlayback(false);
  }, [pendingPlayback, odysseyStatus, musicUrl, narrationUrl]);

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
      setGeneratedBase64(base64);
      setGeneratedMime(mimeType);
      setGenerateStatus('done');
      await runAnalysisAndAudio(base64, mimeType);
    } catch (err) {
      setGenerateStatus('error');
      setGenerateError(err instanceof Error ? err.message : 'Image generation failed.');
    }
  }

  async function runAnalysisAndAudio(imageBase64: string, mimeType: string) {
    setAnalysisStatus('loading');
    setAudioStatus('loading');
    setAudioError(null);
    setMusicUrl(null);
    setNarrationUrl(null);
    setStoryText('');
    setMusicPrompt('');

    try {
      const analysisRes = await fetch('/api/analyze-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageBase64, mimeType }),
      });
      const analysisData = await analysisRes.json();
      if (!analysisRes.ok) {
        throw new Error(analysisData?.error || 'Analysis failed.');
      }
      setAnalysisStatus('done');
      setStoryText(analysisData.story || '');
      setMusicPrompt(analysisData.musicPrompt || '');

      const [musicRes, narrationRes] = await Promise.all([
        fetch('/api/lyria', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ musicPrompt: analysisData.musicPrompt || '' }),
        }),
        fetch('/api/narrate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ storyText: analysisData.story || '' }),
        }),
      ]);

      const musicData = await musicRes.json();
      const narrationData = await narrationRes.json();
      if (!musicRes.ok) throw new Error(musicData?.error || 'Music generation failed.');
      if (!narrationRes.ok) throw new Error(narrationData?.error || 'Narration generation failed.');

      const musicBlob = base64ToBlob(musicData.audioBase64, musicData.mimeType || 'audio/mpeg');
      const narrationBlob = base64ToBlob(narrationData.audioBase64, narrationData.mimeType || 'audio/wav');
      const musicObjectUrl = URL.createObjectURL(musicBlob);
      const narrationObjectUrl = URL.createObjectURL(narrationBlob);
      setMusicUrl(musicObjectUrl);
      setNarrationUrl(narrationObjectUrl);
      setAudioStatus('ready');
    } catch (err) {
      setAnalysisStatus('error');
      setAudioStatus('error');
      setAudioError(err instanceof Error ? err.message : 'Audio pipeline failed.');
    }
  }

  function base64ToBlob(base64: string, mimeType: string) {
    const buffer = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    return new Blob([buffer], { type: mimeType });
  }

  async function startAudioPlayback() {
    if (!musicUrl || !narrationUrl) return;
    if (!musicAudioRef.current) {
      musicAudioRef.current = new Audio(musicUrl);
      musicAudioRef.current.loop = true;
      musicAudioRef.current.volume = 0.5;
    } else {
      musicAudioRef.current.src = musicUrl;
    }
    if (!narrationAudioRef.current) {
      narrationAudioRef.current = new Audio(narrationUrl);
      narrationAudioRef.current.volume = 1;
    } else {
      narrationAudioRef.current.src = narrationUrl;
    }

    try {
      await musicAudioRef.current.play();
      await narrationAudioRef.current.play();
    } catch {
      // Autoplay restrictions may block; user can restart by clicking Start again.
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
      if (musicUrl && narrationUrl) {
        await startAudioPlayback();
      } else {
        setPendingPlayback(true);
      }
    } catch (err) {
      setOdysseyStatus('error');
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
    setGeneratedBase64('');
    setGeneratedMime('image/png');
    setAnalysisStatus('idle');
    setAudioStatus('idle');
    setAudioError(null);
    setMusicUrl(null);
    setNarrationUrl(null);
    setStoryText('');
    setMusicPrompt('');
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
          {analysisStatus === 'loading' && <p className="hint">Analyzing scene…</p>}
          {audioStatus === 'loading' && <p className="hint">Generating music + narration…</p>}
          {audioError && <p className="error">{audioError}</p>}
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
        </section>
      </main>

    </div>
  );
}

export default App;
