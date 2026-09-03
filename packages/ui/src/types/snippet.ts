export interface Snippet {
  id: string;
  name: string;
  content: string;
  aliases: string[];
  description?: string;
  source: 'global' | 'project';
  directory?: string;
}
