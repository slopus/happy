import { listenWindow } from "../../paws/runtime";
import type { DragEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { isFileDrag } from "../../lib/pending-attachments";

/**
 * Files dragged over the composer: `draggingFiles` while they are over it, `fileDragActive` while
 * any file drag is over the window, so the composer's padding can catch the drop.
 */
export function useComposerFileDrop({
  disabled,
  onDropFiles,
}: {
  disabled?: boolean;
  onDropFiles: (files: FileList) => void;
}) {
  const dragDepth = useRef(0);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [fileDragActive, setFileDragActive] = useState(false);
  useEffect(() => {
    // The transparent padding passes ordinary clicks through, but remains a file drop target.
    let depth = 0;
    const enter = (event: globalThis.DragEvent) => {
      if (!isFileDrag(event.dataTransfer)) return;
      depth += 1;
      setFileDragActive(true);
    };
    const finish = () => {
      depth = 0;
      dragDepth.current = 0;
      setFileDragActive(false);
      setDraggingFiles(false);
    };
    const leave = () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) finish();
    };
    listenWindow("dragenter", enter);
    listenWindow("dragleave", leave);
    listenWindow("drop", finish);
    listenWindow("dragend", finish);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", finish);
      window.removeEventListener("dragend", finish);
    };
  }, []);

  function onDragEnter(event: DragEvent<HTMLFieldSetElement>) {
    const dataTransfer = event.dataTransfer;
    if (!isFileDrag(dataTransfer)) return;
    event.preventDefault();
    if (disabled) {
      dragDepth.current = 0;
      setDraggingFiles(false);
      return;
    }
    dragDepth.current += 1;
    setDraggingFiles(true);
  }

  function onDragOver(event: DragEvent<HTMLFieldSetElement>) {
    const dataTransfer = event.dataTransfer;
    if (!isFileDrag(dataTransfer)) return;
    event.preventDefault();
    dataTransfer.dropEffect = disabled ? "none" : "copy";
    if (disabled) {
      dragDepth.current = 0;
      setDraggingFiles(false);
      return;
    }
    setDraggingFiles(true);
  }

  function onDragLeave(event: DragEvent<HTMLFieldSetElement>) {
    if (!isFileDrag(event.dataTransfer)) return;
    if (disabled) {
      dragDepth.current = 0;
      setDraggingFiles(false);
      return;
    }
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDraggingFiles(false);
  }

  function onDrop(event: DragEvent<HTMLFieldSetElement>) {
    const dataTransfer = event.dataTransfer;
    if (!isFileDrag(dataTransfer)) return;
    event.preventDefault();
    dragDepth.current = 0;
    setDraggingFiles(false);
    if (!disabled) onDropFiles(dataTransfer.files);
  }

  return {
    draggingFiles,
    fileDragActive,
    dropHandlers: { onDragEnter, onDragOver, onDragLeave, onDrop },
  };
}
