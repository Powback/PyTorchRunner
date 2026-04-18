/**
 * ImageGallery — Grid view of all training-run images.
 * Features: tag filter, step scrubber, click-to-zoom lightbox.
 */
import React, { useState, useEffect, useCallback, useRef } from 'react';

interface MediaItem {
  id: number;
  filename: string;
  tag: string | null;
  step: number | null;
  wallTime: number | null;
  mediaType: string;
  contentType: string;
  fileSize: number | null;
  width: number | null;
  height: number | null;
  url: string;
}

interface ImageGalleryProps {
  jobId: string;
  className?: string;
}

export default function ImageGallery({ jobId, className = '' }: ImageGalleryProps) {
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [stepRange, setStepRange] = useState<[number, number]>([0, 0]);
  const [stepFilter, setStepFilter] = useState<number | null>(null);
  const [lightbox, setLightbox] = useState<MediaItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pollingActive, setPollingActive] = useState(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchMedia = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (activeTag) params.set('tag', activeTag);
      const qs = params.toString() ? `?${params}` : '';
      const resp = await fetch(`/api/jobs/${jobId}/media${qs}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();

      const images = (data.media as MediaItem[]).filter(m =>
        m.contentType.startsWith('image/')
      );
      setMedia(images);
      setTags(data.tags ?? []);

      if (images.length > 0) {
        const steps = images.map(m => m.step ?? 0).filter(s => s != null) as number[];
        if (steps.length > 0) {
          const min = Math.min(...steps);
          const max = Math.max(...steps);
          setStepRange([min, max]);
          if (stepFilter === null) setStepFilter(null);
        }
      }
      setError(null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [jobId, activeTag]);

  useEffect(() => {
    fetchMedia();
    if (pollingActive) {
      intervalRef.current = setInterval(fetchMedia, 5000);
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchMedia, pollingActive]);

  // Stop polling when we have media and job is done
  useEffect(() => {
    if (media.length > 0) {
      setPollingActive(false);
      if (intervalRef.current) clearInterval(intervalRef.current);
    }
  }, [media.length]);

  // Keyboard nav for lightbox
  useEffect(() => {
    if (!lightbox) return;
    const visible = filteredMedia();
    const idx = visible.findIndex(m => m.id === lightbox.id);
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLightbox(null);
      if (e.key === 'ArrowRight' && idx < visible.length - 1) setLightbox(visible[idx + 1]);
      if (e.key === 'ArrowLeft' && idx > 0) setLightbox(visible[idx - 1]);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [lightbox, media, stepFilter]);

  function filteredMedia(): MediaItem[] {
    if (stepFilter === null) return media;
    // Show closest step for each tag
    const grouped = new Map<string, MediaItem[]>();
    for (const m of media) {
      const key = m.tag ?? '__untagged__';
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(m);
    }
    const result: MediaItem[] = [];
    for (const [, items] of grouped) {
      const sorted = [...items].sort((a, b) =>
        Math.abs((a.step ?? 0) - stepFilter) - Math.abs((b.step ?? 0) - stepFilter)
      );
      if (sorted.length > 0) result.push(sorted[0]);
    }
    return result;
  }

  function formatSize(bytes: number | null): string {
    if (!bytes) return '';
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }

  const displayed = filteredMedia();
  const hasSteps = stepRange[0] !== stepRange[1];

  if (loading) {
    return (
      <div className={`flex items-center justify-center py-12 ${className}`}>
        <div className="animate-spin h-8 w-8 rounded-full border-b-2 border-indigo-600" />
        <span className="ml-3 text-sm text-gray-500">Loading images...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className={`rounded-md bg-red-50 p-4 ${className}`}>
        <p className="text-sm text-red-700">Failed to load media: {error}</p>
        <button onClick={fetchMedia} className="mt-2 text-sm text-red-600 underline">Retry</button>
      </div>
    );
  }

  if (media.length === 0) {
    return (
      <div className={`text-center py-12 ${className}`}>
        <svg className="mx-auto h-12 w-12 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
            d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5zm10.5-11.25h.008v.008h-.008V8.25zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" />
        </svg>
        <p className="mt-2 text-sm text-gray-500">No images logged yet. Images appear here when training scripts call <code>writer.add_image()</code> or save to the artifact directory.</p>
      </div>
    );
  }

  return (
    <div className={className}>
      {/* Controls */}
      <div className="mb-4 space-y-3">
        {/* Tag filters */}
        {tags.length > 0 && (
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => setActiveTag(null)}
              className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                activeTag === null
                  ? 'bg-indigo-600 text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              All
            </button>
            {tags.map(tag => (
              <button
                key={tag}
                onClick={() => setActiveTag(activeTag === tag ? null : tag)}
                className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                  activeTag === tag
                    ? 'bg-indigo-600 text-white'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
              >
                {tag}
              </button>
            ))}
          </div>
        )}

        {/* Step scrubber */}
        {hasSteps && (
          <div className="flex items-center gap-3">
            <span className="text-xs text-gray-500 whitespace-nowrap">Step:</span>
            <input
              type="range"
              min={stepRange[0]}
              max={stepRange[1]}
              step={1}
              value={stepFilter ?? stepRange[1]}
              onChange={e => setStepFilter(Number(e.target.value))}
              className="flex-1 h-2 accent-indigo-600"
            />
            <span className="text-xs font-mono text-gray-700 w-16 text-right">
              {stepFilter !== null ? stepFilter : 'latest'}
            </span>
            {stepFilter !== null && (
              <button
                onClick={() => setStepFilter(null)}
                className="text-xs text-gray-400 hover:text-gray-600"
              >
                ✕
              </button>
            )}
          </div>
        )}

        <div className="flex items-center justify-between">
          <span className="text-xs text-gray-500">{displayed.length} image{displayed.length !== 1 ? 's' : ''}</span>
          <button onClick={fetchMedia} className="text-xs text-indigo-600 hover:text-indigo-800">Refresh</button>
        </div>
      </div>

      {/* Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        {displayed.map(item => (
          <button
            key={item.id}
            onClick={() => setLightbox(item)}
            className="group relative aspect-square bg-gray-100 rounded-lg overflow-hidden hover:ring-2 hover:ring-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all"
          >
            <img
              src={item.url}
              alt={item.tag ?? item.filename}
              className="w-full h-full object-contain"
              loading="lazy"
            />
            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors flex items-end">
              <div className="w-full px-2 py-1 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity">
                <p className="text-white text-xs truncate">{item.tag ?? item.filename}</p>
                {item.step != null && (
                  <p className="text-gray-300 text-xs">step {item.step}</p>
                )}
              </div>
            </div>
          </button>
        ))}
      </div>

      {/* Lightbox */}
      {lightbox && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
          onClick={e => { if (e.target === e.currentTarget) setLightbox(null); }}
        >
          <div className="relative max-w-4xl w-full">
            {/* Close */}
            <button
              onClick={() => setLightbox(null)}
              className="absolute -top-10 right-0 text-white/70 hover:text-white text-2xl"
            >
              ✕
            </button>

            {/* Nav prev */}
            {(() => {
              const visible = filteredMedia();
              const idx = visible.findIndex(m => m.id === lightbox.id);
              return idx > 0 ? (
                <button
                  onClick={() => setLightbox(visible[idx - 1])}
                  className="absolute left-0 top-1/2 -translate-y-1/2 -translate-x-12 text-white/70 hover:text-white text-3xl"
                >
                  ‹
                </button>
              ) : null;
            })()}

            <img
              src={lightbox.url}
              alt={lightbox.tag ?? lightbox.filename}
              className="max-w-full max-h-[80vh] mx-auto rounded-lg object-contain"
            />

            {/* Nav next */}
            {(() => {
              const visible = filteredMedia();
              const idx = visible.findIndex(m => m.id === lightbox.id);
              return idx < visible.length - 1 ? (
                <button
                  onClick={() => setLightbox(visible[idx + 1])}
                  className="absolute right-0 top-1/2 -translate-y-1/2 translate-x-12 text-white/70 hover:text-white text-3xl"
                >
                  ›
                </button>
              ) : null;
            })()}

            {/* Caption */}
            <div className="mt-3 text-center">
              <p className="text-white font-medium">{lightbox.tag ?? lightbox.filename}</p>
              <p className="text-gray-400 text-sm">
                {lightbox.step != null && `Step ${lightbox.step}`}
                {lightbox.width && lightbox.height && ` · ${lightbox.width}×${lightbox.height}`}
                {lightbox.fileSize && ` · ${formatSize(lightbox.fileSize)}`}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
