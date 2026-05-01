import fs from 'node:fs';
import path from 'node:path';

export type OutboundMediaKind = 'photo' | 'document' | 'audio' | 'voice' | 'video';

export type OutboundMediaFile = {
  marker: string;
  path: string;
  kind: OutboundMediaKind;
  size: number;
  fileName: string;
};

const MARKER_PATTERN = /^\s*MEDIA:(.+?)\s*$/gim;

const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const AUDIO_EXTS = new Set(['.mp3', '.m4a', '.aac', '.flac', '.wav']);
const VOICE_EXTS = new Set(['.ogg', '.oga', '.opus']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.webm', '.mkv']);

function expandHome(value: string): string {
  if (value === '~') return process.env.HOME ?? value;
  if (value.startsWith('~/')) return path.join(process.env.HOME ?? '', value.slice(2));
  return value;
}

function isInsideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function mediaKindForPath(filePath: string): OutboundMediaKind {
  const ext = path.extname(filePath).toLowerCase();
  if (PHOTO_EXTS.has(ext)) return 'photo';
  if (VOICE_EXTS.has(ext)) return 'voice';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  if (VIDEO_EXTS.has(ext)) return 'video';
  return 'document';
}

export function extractMediaMarkers(text: string): string[] {
  const markers: string[] = [];
  for (const match of text.matchAll(MARKER_PATTERN)) {
    const value = match[1]?.trim();
    if (value) markers.push(value);
  }
  return [...new Set(markers)];
}

export function stripMediaMarkers(text: string): string {
  return text.replace(MARKER_PATTERN, '').replace(/\n{3,}/g, '\n\n').trim();
}

export function resolveOutboundMediaFiles(options: {
  text: string;
  workspaceRoot: string;
  maxBytes: number;
  extraAllowedRoots?: string[];
}): { files: OutboundMediaFile[]; errors: string[] } {
  const workspaceRoot = path.resolve(expandHome(options.workspaceRoot));
  const allowedRoots = [workspaceRoot, ...(options.extraAllowedRoots ?? []).map((root) => path.resolve(expandHome(root)))];
  const files: OutboundMediaFile[] = [];
  const errors: string[] = [];

  for (const marker of extractMediaMarkers(options.text)) {
    const raw = marker.replace(/^['"]|['"]$/g, '');
    if (!path.isAbsolute(raw)) {
      errors.push(`MEDIA path must be absolute: ${marker}`);
      continue;
    }

    const resolved = path.resolve(expandHome(raw));
    if (!allowedRoots.some((root) => isInsideRoot(root, resolved))) {
      errors.push(`MEDIA path is outside allowed roots: ${resolved}`);
      continue;
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolved);
    } catch {
      errors.push(`MEDIA file does not exist: ${resolved}`);
      continue;
    }

    if (!stat.isFile()) {
      errors.push(`MEDIA path is not a file: ${resolved}`);
      continue;
    }

    if (stat.size > options.maxBytes) {
      errors.push(`MEDIA file too large (${stat.size} bytes): ${resolved}`);
      continue;
    }

    files.push({
      marker,
      path: resolved,
      kind: mediaKindForPath(resolved),
      size: stat.size,
      fileName: path.basename(resolved),
    });
  }

  return { files, errors };
}
