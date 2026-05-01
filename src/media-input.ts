import fs from 'node:fs/promises';
import path from 'node:path';

const TEXT_EXTS = new Set(['.txt', '.md', '.json', '.csv', '.log', '.ts', '.tsx', '.js', '.jsx', '.py', '.yaml', '.yml', '.html', '.xml', '.sql', '.toml', '.ini', '.css', '.scss', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.hpp', '.sh']);

export function isTextDocumentExtension(ext: string): boolean {
  return TEXT_EXTS.has(ext.toLowerCase());
}

export function supportedTextDocumentExtensions(): string[] {
  return [...TEXT_EXTS].sort();
}

export async function saveTelegramMediaFile(options: { data: Buffer; workspaceRoot: string; fileName: string; subdir?: string }): Promise<string> {
  const safeName = options.fileName.replace(/[^\w. -]/g, '_') || `telegram-media-${Date.now()}`;
  const dir = path.resolve(options.workspaceRoot, options.subdir ?? '.telegram-media');
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${Date.now()}-${safeName}`);
  await fs.writeFile(filePath, options.data);
  return filePath;
}

export function mediaSavedPrompt(kind: string, filePath: string, caption?: string): string {
  return [`User sent a ${kind} saved at:`, filePath, '', 'Please inspect or process this file if your tools support it.', caption ? `\nUser note: ${caption}` : ''].join('\n');
}
