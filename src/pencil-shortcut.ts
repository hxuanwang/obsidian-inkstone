/** Obsidian reserves `action` for the URI handler name; use `gesture` for the mapping. */
export function pencilSqueezeShortcutUrl(vault: string): string {
  return `obsidian://inkstone-pencil?vault=${encodeURIComponent(vault)}&gesture=squeeze`;
}
