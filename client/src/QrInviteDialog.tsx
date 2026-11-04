import { useEffect, useMemo, useRef, type RefObject } from "react";
import encodeQR from "qr";

const QUIET_ZONE_MODULES = 4;

interface QrInviteDialogProps {
  inviteUrl: string;
  note?: string;
  onClose: () => void;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
}

function createQrPath(modules: boolean[][]): string {
  let path = "";
  for (let y = 0; y < modules.length; y += 1) {
    for (let x = 0; x < modules[y].length; x += 1) {
      if (modules[y][x]) path += `M${x + QUIET_ZONE_MODULES} ${y + QUIET_ZONE_MODULES}h1v1h-1z`;
    }
  }
  return path;
}

export function QrInviteDialog({
  inviteUrl,
  note = "This invite can be used once.",
  onClose,
  returnFocusRef
}: QrInviteDialogProps) {
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const qr = useMemo(() => {
    const modules = encodeQR(inviteUrl, "raw", { ecc: "medium" });
    return {
      path: createQrPath(modules),
      size: modules.length + QUIET_ZONE_MODULES * 2
    };
  }, [inviteUrl]);

  useEffect(() => {
    const returnFocusElement = returnFocusRef.current;
    closeButtonRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      if (returnFocusElement?.isConnected) returnFocusElement.focus();
    };
  }, [onClose, returnFocusRef]);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="qr-dialog" role="dialog" aria-modal="true" aria-label="QR invite" aria-describedby="qr-note">
        <h2>Scan to join</h2>
        <svg
          className="qr-code"
          viewBox={`0 0 ${qr.size} ${qr.size}`}
          shapeRendering="crispEdges"
          aria-hidden="true"
          data-qr-value={inviteUrl}
          data-quiet-zone={QUIET_ZONE_MODULES}
        >
          <rect width={qr.size} height={qr.size} fill="#fff" />
          <path d={qr.path} fill="#111" />
        </svg>
        <p id="qr-note">{note}</p>
        <button ref={closeButtonRef} type="button" onClick={onClose}>Close</button>
      </section>
    </div>
  );
}
