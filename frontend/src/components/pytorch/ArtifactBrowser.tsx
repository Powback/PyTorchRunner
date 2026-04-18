/**
 * ArtifactBrowser — File browser for all job artifacts.
 * Groups by type, shows download links, previews images/JSON/text.
 */
import React, { useState, useEffect, useCallback } from 'react';

interface ArtifactItem {
  id: number;
  filename: string;
  tag: string | null;
  step: number | null;
  mediaType: string;
  contentType: string;
  fileSize: number | null;
  width: number | null;
  height: number | null;
  createdAt: string;
  url: string;
}

interface ArtifactsData {
  jobId: string;
  artifacts: Record<string, ArtifactItem[]>;
  counts: Record<string, number>;
  total: number;
}

interface ArtifactBrowserProps {
  jobId: string;
  className?: string;
}

const TYPE_ICONS: Record<string, React.ReactNode> = {
  image: (
    <svg className="h-5 w-5 text-indigo-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
        d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M18.75 6.75h.008v.008h-.008V6.75z" />
    </svg>
  ),
  json: (
    <svg className="h-5 w-5 text-yellow-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
        d="M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5" />
    </svg>
  ),
  checkpoint: (
    <svg className="h-5 w-5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
        d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 0v3.75m-16.5-3.75v3.75" />
    </svg>
  ),
  text: (
    <svg className="h-5 w-5 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
        d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
    </svg>
  ),
  other: (
    <svg className="h-5 w-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
        d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
    </svg>
  ),
};

const TYPE_LABELS: Record<string, string> = {
  image: 'Images',
  json: 'Result JSON',
  checkpoint: 'Checkpoints',
  text: 'Text Files',
  other: 'Other Files',
};

function formatSize(bytes: number | null): string {
  if (!bytes) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

function JsonPreview({ url }: { url: string }) {
  const [content, setContent] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(url)
      .then(r => r.json())
      .then(data => { setContent(data); setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [url]);

  if (loading) return <div className="text-xs text-gray-400 italic p-2">Loading...</div>;
  if (error) return <div className="text-xs text-red-400 p-2">Failed to load: {error}</div>;

  return (
    <pre className="text-xs bg-gray-900 text-green-400 p-3 rounded-md overflow-auto max-h-64 whitespace-pre-wrap break-all">
      {JSON.stringify(content, null, 2)}
    </pre>
  );
}

function ArtifactRow({ item, jobId }: { item: ArtifactItem; jobId: string }) {
  const [expanded, setExpanded] = useState(false);

  const icon = TYPE_ICONS[item.mediaType] ?? TYPE_ICONS.other;
  const isPreviewable = item.mediaType === 'image' || item.mediaType === 'json';

  return (
    <li className="group">
      <div className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50 rounded-lg transition-colors">
        <span className="flex-shrink-0">{icon}</span>

        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-gray-900 truncate">{item.filename}</p>
          <p className="text-xs text-gray-400">
            {formatSize(item.fileSize)}
            {item.tag && ` · tag: ${item.tag}`}
            {item.step != null && ` · step ${item.step}`}
            {item.width && item.height && ` · ${item.width}×${item.height}`}
          </p>
          <p className="text-xs text-gray-300">{formatDate(item.createdAt)}</p>
        </div>

        <div className="flex items-center gap-2 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
          {isPreviewable && (
            <button
              onClick={() => setExpanded(p => !p)}
              className="text-xs text-indigo-600 hover:text-indigo-800 font-medium"
            >
              {expanded ? 'Hide' : 'Preview'}
            </button>
          )}
          <a
            href={item.url}
            download={item.filename}
            className="text-xs text-gray-600 hover:text-gray-900 font-medium"
            onClick={e => e.stopPropagation()}
          >
            Download
          </a>
        </div>
      </div>

      {expanded && (
        <div className="px-4 pb-3">
          {item.mediaType === 'image' ? (
            <img
              src={item.url}
              alt={item.filename}
              className="max-h-64 rounded-md object-contain bg-gray-100"
            />
          ) : item.mediaType === 'json' ? (
            <JsonPreview url={item.url} />
          ) : null}
        </div>
      )}
    </li>
  );
}

export default function ArtifactBrowser({ jobId, className = '' }: ArtifactBrowserProps) {
  const [data, setData] = useState<ArtifactsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openSections, setOpenSections] = useState<Set<string>>(new Set(['image', 'json']));

  const fetchArtifacts = useCallback(async () => {
    try {
      const resp = await fetch(`/api/jobs/${jobId}/artifacts`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      setData(await resp.json());
      setError(null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [jobId]);

  useEffect(() => { fetchArtifacts(); }, [fetchArtifacts]);

  function toggleSection(type: string) {
    setOpenSections(prev => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }

  if (loading) {
    return (
      <div className={`flex items-center justify-center py-12 ${className}`}>
        <div className="animate-spin h-8 w-8 rounded-full border-b-2 border-indigo-600" />
        <span className="ml-3 text-sm text-gray-500">Loading artifacts...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className={`rounded-md bg-red-50 p-4 ${className}`}>
        <p className="text-sm text-red-700">Failed to load artifacts: {error}</p>
        <button onClick={fetchArtifacts} className="mt-2 text-sm text-red-600 underline">Retry</button>
      </div>
    );
  }

  const total = data?.total ?? 0;
  const artifacts = data?.artifacts ?? {};
  const types = Object.keys(artifacts).sort((a, b) => {
    const order = ['image', 'json', 'checkpoint', 'text', 'other'];
    return (order.indexOf(a) - order.indexOf(b));
  });

  if (total === 0) {
    return (
      <div className={`text-center py-12 ${className}`}>
        <svg className="mx-auto h-12 w-12 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
            d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
        </svg>
        <p className="mt-2 text-sm text-gray-500">
          No artifacts yet. The runner uploads images, JSON results, and checkpoints automatically when the job completes.
        </p>
      </div>
    );
  }

  return (
    <div className={className}>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-gray-500">{total} artifact{total !== 1 ? 's' : ''} across {types.length} type{types.length !== 1 ? 's' : ''}</p>
        <button onClick={fetchArtifacts} className="text-xs text-indigo-600 hover:text-indigo-800">Refresh</button>
      </div>

      <div className="space-y-3">
        {types.map(type => {
          const items = artifacts[type] ?? [];
          const isOpen = openSections.has(type);
          return (
            <div key={type} className="border border-gray-200 rounded-lg overflow-hidden">
              <button
                onClick={() => toggleSection(type)}
                className="w-full flex items-center justify-between px-4 py-3 bg-gray-50 hover:bg-gray-100 text-left transition-colors"
              >
                <div className="flex items-center gap-2">
                  {TYPE_ICONS[type] ?? TYPE_ICONS.other}
                  <span className="text-sm font-medium text-gray-800">
                    {TYPE_LABELS[type] ?? type}
                  </span>
                  <span className="text-xs text-gray-400 bg-gray-200 rounded-full px-2 py-0.5">
                    {items.length}
                  </span>
                </div>
                <svg
                  className={`h-4 w-4 text-gray-500 transition-transform ${isOpen ? 'rotate-180' : ''}`}
                  fill="none" viewBox="0 0 24 24" stroke="currentColor"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>

              {isOpen && (
                <ul className="divide-y divide-gray-100">
                  {items.map(item => (
                    <ArtifactRow key={item.id} item={item} jobId={jobId} />
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
