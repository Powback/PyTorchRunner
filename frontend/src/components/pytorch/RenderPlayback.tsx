/**
 * RenderPlayback — Animate sequential images across training steps.
 * Play/pause/scrub with frame rate control.
 * Useful for RL environments, generative models showing evolution.
 */
import React, { useState, useEffect, useRef, useCallback } from 'react';

interface MediaItem {
  id: number;
  filename: string;
  tag: string | null;
  step: number | null;
  url: string;
}

interface RenderPlaybackProps {
  jobId: string;
  className?: string;
}

const FPS_OPTIONS = [1, 2, 4, 8, 12, 24];

export default function RenderPlayback({ jobId, className = '' }: RenderPlaybackProps) {
  const [allMedia, setAllMedia] = useState<MediaItem[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [frames, setFrames] = useState<MediaItem[]>([]);
  const [currentFrame, setCurrentFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [fps, setFps] = useState(4);
  const [loop, setLoop] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const preloadedRef = useRef<Set<string>>(new Set());

  const fetchMedia = useCallback(async () => {
    try {
      const resp = await fetch(`/api/jobs/${jobId}/media`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      const images = (data.media as MediaItem[]).filter(m => {
        // Only items with a step (sequential frames)
        return m.step != null;
      });
      setAllMedia(images);
      setTags(data.tags ?? []);
      setError(null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [jobId]);

  useEffect(() => { fetchMedia(); }, [fetchMedia]);

  // Build frames for active tag
  useEffect(() => {
    let filtered = allMedia;
    if (activeTag) {
      filtered = allMedia.filter(m => m.tag === activeTag);
    }
    // Sort by step
    const sorted = [...filtered].sort((a, b) => (a.step ?? 0) - (b.step ?? 0));
    setFrames(sorted);
    setCurrentFrame(0);
    setPlaying(false);
  }, [allMedia, activeTag]);

  // Preload images
  useEffect(() => {
    for (const frame of frames) {
      if (!preloadedRef.current.has(frame.url)) {
        const img = new Image();
        img.src = frame.url;
        preloadedRef.current.add(frame.url);
      }
    }
  }, [frames]);

  // Playback loop
  useEffect(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    if (!playing || frames.length === 0) return;

    intervalRef.current = setInterval(() => {
      setCurrentFrame(prev => {
        const next = prev + 1;
        if (next >= frames.length) {
          if (loop) return 0;
          setPlaying(false);
          return prev;
        }
        return next;
      });
    }, 1000 / fps);

    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [playing, fps, frames.length, loop]);

  if (loading) {
    return (
      <div className={`flex items-center justify-center py-12 ${className}`}>
        <div className="animate-spin h-8 w-8 rounded-full border-b-2 border-indigo-600" />
        <span className="ml-3 text-sm text-gray-500">Loading frames...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className={`rounded-md bg-red-50 p-4 ${className}`}>
        <p className="text-sm text-red-700">Failed to load frames: {error}</p>
      </div>
    );
  }

  if (allMedia.filter(m => m.step != null).length === 0) {
    return (
      <div className={`text-center py-12 ${className}`}>
        <svg className="mx-auto h-12 w-12 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
            d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.348a1.125 1.125 0 010 1.971l-11.54 6.347a1.125 1.125 0 01-1.667-.985V5.653z" />
        </svg>
        <p className="mt-2 text-sm text-gray-500">No sequential frames yet. Images appear here as training progresses (requires step numbers).</p>
      </div>
    );
  }

  const currentItem = frames[currentFrame];

  return (
    <div className={className}>
      {/* Tag selector */}
      {tags.length > 1 && (
        <div className="mb-4 flex flex-wrap gap-2">
          <button
            onClick={() => setActiveTag(null)}
            className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
              activeTag === null ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            All
          </button>
          {tags.map(tag => (
            <button
              key={tag}
              onClick={() => setActiveTag(tag)}
              className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                activeTag === tag ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              {tag}
            </button>
          ))}
        </div>
      )}

      {/* Viewer */}
      <div className="bg-black rounded-xl overflow-hidden aspect-video flex items-center justify-center relative">
        {currentItem ? (
          <img
            src={currentItem.url}
            alt={`Step ${currentItem.step}`}
            className="max-w-full max-h-full object-contain"
            key={currentItem.url}
          />
        ) : (
          <div className="text-gray-500 text-sm">No frames for selected tag</div>
        )}

        {/* Step badge */}
        {currentItem?.step != null && (
          <div className="absolute top-3 right-3 bg-black/60 text-white text-xs px-2 py-1 rounded font-mono">
            step {currentItem.step}
          </div>
        )}

        {/* Frame counter */}
        <div className="absolute top-3 left-3 bg-black/60 text-white text-xs px-2 py-1 rounded">
          {currentFrame + 1} / {frames.length}
        </div>
      </div>

      {/* Scrubber */}
      <div className="mt-3">
        <input
          type="range"
          min={0}
          max={Math.max(0, frames.length - 1)}
          value={currentFrame}
          onChange={e => {
            setPlaying(false);
            setCurrentFrame(Number(e.target.value));
          }}
          className="w-full h-2 accent-indigo-600"
        />
      </div>

      {/* Controls */}
      <div className="mt-3 flex items-center gap-3 flex-wrap">
        {/* Rewind */}
        <button
          onClick={() => { setPlaying(false); setCurrentFrame(0); }}
          className="p-2 rounded-full bg-gray-100 hover:bg-gray-200 text-gray-700"
          title="Rewind"
        >
          <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 20 20">
            <path d="M8.445 14.832A1 1 0 0010 14v-2.798l5.445 3.63A1 1 0 0017 14V6a1 1 0 00-1.555-.832L10 8.798V6a1 1 0 00-1.555-.832l-6 4a1 1 0 000 1.664l6 4z" />
          </svg>
        </button>

        {/* Play/Pause */}
        <button
          onClick={() => setPlaying(p => !p)}
          disabled={frames.length === 0}
          className="p-2 rounded-full bg-indigo-600 hover:bg-indigo-700 text-white disabled:opacity-40"
        >
          {playing ? (
            <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zM7 8a1 1 0 012 0v4a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v4a1 1 0 102 0V8a1 1 0 00-1-1z" clipRule="evenodd" />
            </svg>
          ) : (
            <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clipRule="evenodd" />
            </svg>
          )}
        </button>

        {/* FPS selector */}
        <div className="flex items-center gap-1">
          <span className="text-xs text-gray-500">FPS:</span>
          <select
            value={fps}
            onChange={e => setFps(Number(e.target.value))}
            className="text-xs border border-gray-300 rounded px-1 py-0.5"
          >
            {FPS_OPTIONS.map(f => <option key={f} value={f}>{f}</option>)}
          </select>
        </div>

        {/* Loop toggle */}
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input
            type="checkbox"
            checked={loop}
            onChange={e => setLoop(e.target.checked)}
            className="rounded accent-indigo-600"
          />
          <span className="text-xs text-gray-600">Loop</span>
        </label>

        <div className="ml-auto text-xs text-gray-400">
          {frames.length} frame{frames.length !== 1 ? 's' : ''}
        </div>
      </div>
    </div>
  );
}
