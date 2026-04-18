/**
 * ImageComparison — Side-by-side image comparison across jobs at the same step.
 * Useful for comparing model outputs from different runs.
 */
import React, { useState, useEffect, useCallback } from 'react';

interface MediaItem {
  id: number;
  filename: string;
  tag: string | null;
  step: number | null;
  url: string;
  jobId?: string;
}

interface JobSlot {
  jobId: string;
  label: string;
  media: MediaItem[];
  tags: string[];
}

interface ImageComparisonProps {
  jobIds: string[];
  labels?: string[];
  className?: string;
}

export default function ImageComparison({
  jobIds,
  labels,
  className = '',
}: ImageComparisonProps) {
  const [slots, setSlots] = useState<JobSlot[]>([]);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [step, setStep] = useState<number | null>(null);
  const [allSteps, setAllSteps] = useState<number[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    try {
      const results = await Promise.all(
        jobIds.map(async (id, i) => {
          const resp = await fetch(`/api/jobs/${id}/media`);
          if (!resp.ok) throw new Error(`HTTP ${resp.status} for job ${id}`);
          const data = await resp.json();
          return {
            jobId: id,
            label: labels?.[i] ?? `Job ${i + 1}: ${id.slice(0, 8)}`,
            media: (data.media as MediaItem[]).filter(m => m.step != null),
            tags: data.tags ?? [],
          } as JobSlot;
        })
      );
      setSlots(results);

      // Collect all steps across all jobs
      const stepSet = new Set<number>();
      for (const slot of results) {
        for (const m of slot.media) {
          if (m.step != null) stepSet.add(m.step);
        }
      }
      const sorted = [...stepSet].sort((a, b) => a - b);
      setAllSteps(sorted);
      if (sorted.length > 0 && step === null) {
        setStep(sorted[sorted.length - 1]); // default to latest
      }

      setError(null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [jobIds.join(',')]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // Collect all unique tags
  const allTags = [...new Set(slots.flatMap(s => s.tags))].sort();

  function getFrameForSlot(slot: JobSlot): MediaItem | null {
    let filtered = slot.media;
    if (activeTag) filtered = filtered.filter(m => m.tag === activeTag);
    if (step != null) {
      // Find closest step
      return filtered.reduce<MediaItem | null>((best, m) => {
        if (!best) return m;
        return Math.abs((m.step ?? 0) - step) < Math.abs((best.step ?? 0) - step) ? m : best;
      }, null);
    }
    return filtered[filtered.length - 1] ?? null;
  }

  if (loading) {
    return (
      <div className={`flex items-center justify-center py-12 ${className}`}>
        <div className="animate-spin h-8 w-8 rounded-full border-b-2 border-indigo-600" />
        <span className="ml-3 text-sm text-gray-500">Loading comparison...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className={`rounded-md bg-red-50 p-4 ${className}`}>
        <p className="text-sm text-red-700">Failed to load: {error}</p>
      </div>
    );
  }

  const hasImages = slots.some(s => s.media.length > 0);
  if (!hasImages) {
    return (
      <div className={`text-center py-12 ${className}`}>
        <p className="text-sm text-gray-500">No images available for the selected jobs.</p>
      </div>
    );
  }

  return (
    <div className={className}>
      {/* Controls */}
      <div className="mb-4 space-y-3">
        {allTags.length > 0 && (
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => setActiveTag(null)}
              className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                activeTag === null ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              All tags
            </button>
            {allTags.map(tag => (
              <button
                key={tag}
                onClick={() => setActiveTag(activeTag === tag ? null : tag)}
                className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                  activeTag === tag ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
              >
                {tag}
              </button>
            ))}
          </div>
        )}

        {allSteps.length > 1 && (
          <div className="flex items-center gap-3">
            <span className="text-xs text-gray-500 whitespace-nowrap">Step:</span>
            <input
              type="range"
              min={allSteps[0]}
              max={allSteps[allSteps.length - 1]}
              value={step ?? allSteps[allSteps.length - 1]}
              onChange={e => setStep(Number(e.target.value))}
              className="flex-1 h-2 accent-indigo-600"
            />
            <span className="text-xs font-mono text-gray-700 w-16 text-right">
              {step ?? allSteps[allSteps.length - 1]}
            </span>
          </div>
        )}
      </div>

      {/* Side-by-side grid */}
      <div
        className="grid gap-4"
        style={{ gridTemplateColumns: `repeat(${Math.min(slots.length, 3)}, 1fr)` }}
      >
        {slots.map(slot => {
          const frame = getFrameForSlot(slot);
          return (
            <div key={slot.jobId} className="space-y-2">
              <div className="bg-black rounded-lg overflow-hidden aspect-square flex items-center justify-center">
                {frame ? (
                  <img
                    src={frame.url}
                    alt={frame.tag ?? frame.filename}
                    className="max-w-full max-h-full object-contain"
                  />
                ) : (
                  <div className="text-gray-500 text-xs text-center px-2">No image at this step</div>
                )}
              </div>
              <div className="text-center">
                <p className="text-xs font-medium text-gray-700 truncate" title={slot.label}>{slot.label}</p>
                {frame?.step != null && (
                  <p className="text-xs text-gray-400">step {frame.step}</p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
