export interface BlogPost {
  slug: string;
  title: string;
  subtitle?: string;
  description: string;
  author: string;
  authorRole?: string;
  publishedAt: string;
  updatedAt?: string;
  tags: string[];
  readingTime: number;
  coverImage?: string;
  content: string;
}
