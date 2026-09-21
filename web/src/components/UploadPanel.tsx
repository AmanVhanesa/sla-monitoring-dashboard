import { useRef, useState } from 'react';
import { uploadCsv } from '../api';
import type { Upload } from '../types';
import { formatInteger } from '../format';

interface Props {
  onUploaded: (upload: Upload) => void;
}

export function UploadPanel({ onUploaded }: Props) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState({ sent: 0, total: 0 });
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleFile(file: File | undefined) {
    if (!file) return;
    if (!/\.csv$/i.test(file.name)) {
      setError('Please choose a .csv file.');
      return;
    }

    setBusy(true);
    setError(null);
    setProgress({ sent: 0, total: 0 });

    try {
      const upload = await uploadCsv(file, setProgress);
      onUploaded(upload);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Upload failed.');
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  const percent = progress.total ? Math.round((progress.sent / progress.total) * 100) : 0;

  return (
    <section className="panel">
      <div
        className={`dropzone ${dragging ? 'dropzone--active' : ''} ${busy ? 'dropzone--busy' : ''}`}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          if (!busy) void handleFile(event.dataTransfer.files[0]);
        }}
        onClick={() => !busy && inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') inputRef.current?.click();
        }}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".csv,text/csv"
          hidden
          onChange={(event) => void handleFile(event.target.files?.[0])}
        />

        {busy ? (
          <>
            <strong>Cleaning in the cloud function…</strong>
            <div className="progress">
              <div className="progress__bar" style={{ width: `${percent}%` }} />
            </div>
            <span className="muted">
              {formatInteger(progress.sent)} of {formatInteger(progress.total)} rows sent ({percent}%)
            </span>
          </>
        ) : (
          <>
            <strong>Drop a monitoring CSV here, or click to choose one</strong>
            <span className="muted">
              Sent to the Worker in 500-row slices; parsing, validation and cleaning all happen there.
            </span>
          </>
        )}
      </div>

      {error && <p className="error">{error}</p>}
    </section>
  );
}
