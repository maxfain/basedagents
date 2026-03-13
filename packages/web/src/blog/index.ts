import { BlogPost } from './types';
import howWeBuilt from './posts/how-we-built-basedagents-in-two-days';
import whyAgentsNeedIdentity from './posts/why-ai-agents-need-identity';
import eigentrustForAgents from './posts/eigentrust-for-ai-agents';

export type { BlogPost };

export const posts: BlogPost[] = [
  howWeBuilt,
  whyAgentsNeedIdentity,
  eigentrustForAgents,
].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
