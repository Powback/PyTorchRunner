/**
 * MediaPanel — Tab container for all media/artifact views.
 * Displays image gallery, render playback, and artifact browser in tabs.
 */
import React, { useState, useEffect } from 'react';
import ImageGallery from './ImageGallery';
import RenderPlayback from './RenderPlayback';
import ArtifactBrowser from './ArtifactBrowser';

interface MediaPanelProps {
  jobId: string;
  className?: string;
}

type Tab = 'gallery' | 'playback' | 'artifacts';

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  {
    id: 'gallery',
    label: 'Gallery',
    icon: (
      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
          d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5zm10.5-11.25h.008v.008h-.008V8.25zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" />
      </svg>
    ),
  },
  {
    id: 'playback',
    label: 'Playback',
    icon: (
      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
          d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.348a1.125 1.125 0 010 1.971l-11.54 6.347a1.125 1.125 0 01-1.667-.985V5.653z" />
      </svg>
    ),
  },
  {
    id: 'artifacts',
    label: 'Artifacts',
    icon: (
      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
          d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
      </svg>
    ),
  },
];

export default function MediaPanel({ jobId, className = '' }: MediaPanelProps) {
  const [activeTab, setActiveTab] = useState<Tab>('gallery');
  const [counts, setCounts] = useState<{ images: number; artifacts: number } | null>(null);

  // Fetch counts for badge display
  useEffect(() => {
    fetch(`/api/jobs/${jobId}/artifacts`)
      .then(r => r.json())
      .then(data => {
        setCounts({
          images: (data.counts?.image ?? 0),
          artifacts: data.total ?? 0,
        });
      })
      .catch(() => {});
  }, [jobId]);

  return (
    <div className={`bg-white rounded-lg shadow-sm ring-1 ring-gray-900/5 ${className}`}>
      {/* Tab header */}
      <div className="border-b border-gray-200 px-4">
        <nav className="-mb-px flex gap-1" aria-label="Media tabs">
          {TABS.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-1.5 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab.id
                  ? 'border-indigo-500 text-indigo-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              {tab.icon}
              {tab.label}
              {tab.id === 'gallery' && counts?.images != null && counts.images > 0 && (
                <span className="ml-1 text-xs bg-indigo-100 text-indigo-700 rounded-full px-1.5 py-0.5">
                  {counts.images}
                </span>
              )}
              {tab.id === 'artifacts' && counts?.artifacts != null && counts.artifacts > 0 && (
                <span className="ml-1 text-xs bg-gray-100 text-gray-600 rounded-full px-1.5 py-0.5">
                  {counts.artifacts}
                </span>
              )}
            </button>
          ))}
        </nav>
      </div>

      {/* Tab content */}
      <div className="p-4">
        {activeTab === 'gallery' && (
          <ImageGallery jobId={jobId} />
        )}
        {activeTab === 'playback' && (
          <RenderPlayback jobId={jobId} />
        )}
        {activeTab === 'artifacts' && (
          <ArtifactBrowser jobId={jobId} />
        )}
      </div>
    </div>
  );
}
