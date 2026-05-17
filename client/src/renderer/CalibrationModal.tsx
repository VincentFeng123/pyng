import { useCallback, useEffect, useState } from 'react';
import type { CalibrationResultPayload } from '@pyng/shared';
import { Button } from './components/Button.js';

type Phase = 'idle' | 'recording' | 'done';

type CalibrationModalProps = {
  isOpen: boolean;
  onClose: () => void;
  onSaved: () => void;
};

export function CalibrationModal({
  isOpen,
  onClose,
  onSaved,
}: CalibrationModalProps): JSX.Element | null {
  const [phase, setPhase] = useState<Phase>('idle');
  const [result, setResult] = useState<CalibrationResultPayload | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    const unsub = window.pyng.calibration.onResult((payload) => {
      setResult(payload);
      setPhase('done');
    });
    return unsub;
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      setPhase('idle');
      setResult(null);
    }
  }, [isOpen]);

  const handleStart = useCallback(() => {
    setPhase('recording');
    window.pyng.calibration.start().catch(() => setPhase('idle'));
  }, []);

  const handleStop = useCallback(() => {
    window.pyng.calibration.stop().catch(() => {});
  }, []);

  const handleSave = useCallback(() => {
    if (!result) return;
    window.pyng.settings
      .saveCalibrationData({
        pixelsPerDegree: result.pixelsPerDegree,
        mousePixelsPerDegree: result.mousePixelsPerDegree,
        calibratedAt: Date.now(),
      })
      .then(() => {
        onSaved();
        onClose();
      })
      .catch(() => {});
  }, [result, onClose, onSaved]);

  const handleRerun = useCallback(() => {
    setPhase('idle');
    setResult(null);
  }, []);

  if (!isOpen) return null;

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Calibration">
      <div className="modal">
        <h2 className="section-title">Tracking Calibration</h2>

        {phase === 'idle' && (
          <>
            <p className="section-help">
              Aim at a fixed object in a Roblox FPS. Slowly rotate your camera 360&deg; to the right
              by holding right-click and dragging the mouse.
            </p>
            <div className="button-row">
              <Button variant="primary" onClick={handleStart}>
                Start
              </Button>
              <Button variant="secondary" onClick={onClose}>
                Cancel
              </Button>
            </div>
          </>
        )}

        {phase === 'recording' && (
          <>
            <p className="section-help">Recording&hellip; rotate 360&deg; then click Stop.</p>
            <div className="button-row">
              <Button variant="danger" onClick={handleStop}>
                Stop
              </Button>
            </div>
          </>
        )}

        {phase === 'done' && result && (
          <>
            <p className="section-help">Calibration complete.</p>
            <div className="calibration-results">
              <span>Pixels / degree</span>
              <code>{result.pixelsPerDegree.toFixed(2)}</code>
              <span>Mouse px / degree</span>
              <code>{result.mousePixelsPerDegree.toFixed(2)}</code>
              <span>Duration</span>
              <code>{result.durationMs}ms</code>
            </div>
            <div className="button-row">
              <Button variant="primary" onClick={handleSave}>
                Save
              </Button>
              <Button variant="secondary" onClick={handleRerun}>
                Re-run
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
